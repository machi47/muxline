import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessKind, LaunchProfile, NativeSessionRef } from "@muxline/protocol";

export interface NativeCandidate {
  id: string;
  sourcePath: string;
  modifiedAt: Date;
  confidence: NativeSessionRef["confidence"];
}

export interface NativeAdapter {
  readonly harness: HarnessKind;
  launchHint(args: readonly string[]): string | null;
  isEphemeral(args: readonly string[]): boolean;
  discover(options: {
    profile: LaunchProfile;
    cwd: string;
    environment: Readonly<Record<string, string>>;
    launchedAt: Date;
  }): Promise<NativeCandidate[]>;
  resumeCommand(profile: LaunchProfile, id: string): string;
}

export function nativeAdapterFor(harness: HarnessKind): NativeAdapter | null {
  if (harness === "claude-code") return claudeAdapter;
  if (harness === "codex") return codexAdapter;
  return null;
}

export function unresolvedNativeRef(harness: HarnessKind): NativeSessionRef {
  return {
    harness,
    id: null,
    status: "unresolved",
    confidence: "none",
    title: null,
    sourcePath: null,
    updatedAt: null,
    resumeCommand: null,
  };
}

export function linkedNativeRef(
  adapter: NativeAdapter,
  profile: LaunchProfile,
  candidate: NativeCandidate,
): NativeSessionRef {
  return {
    harness: adapter.harness,
    id: candidate.id,
    status: "linked",
    confidence: candidate.confidence,
    title: null,
    sourcePath: candidate.sourcePath,
    updatedAt: candidate.modifiedAt.toISOString(),
    resumeCommand: adapter.resumeCommand(profile, candidate.id),
  };
}

const claudeAdapter: NativeAdapter = {
  harness: "claude-code",
  launchHint(args) {
    return optionValue(args, ["--resume", "-r", "--session-id"]);
  },
  isEphemeral() { return false; },
  async discover({ cwd, environment, launchedAt }) {
    const configDir = environment.CLAUDE_CONFIG_DIR
      ? path.resolve(environment.CLAUDE_CONFIG_DIR)
      : path.join(homeDirectory(environment), ".claude");
    const encoded = cwd.replace(/[^A-Za-z0-9]/g, "-");
    const directory = path.join(configDir, "projects", encoded);
    const candidates = await recentFiles(directory, (name) => name.endsWith(".jsonl"), launchedAt);
    return candidates.map((newest) => ({
      id: newest.name.slice(0, -".jsonl".length),
      sourcePath: newest.path,
      modifiedAt: newest.modifiedAt,
      confidence: "observed",
    }));
  },
  resumeCommand(profile, id) {
    return `${profile.invocation} --resume ${id}`;
  },
};

const codexAdapter: NativeAdapter = {
  harness: "codex",
  launchHint(args) {
    const resumeIndex = args.findIndex((value) => value === "resume");
    if (resumeIndex >= 0) {
      const value = args[resumeIndex + 1];
      if (value && !value.startsWith("-")) return value;
    }
    return optionValue(args, ["--resume", "-r"]);
  },
  isEphemeral(args) { return args.includes("--ephemeral"); },
  async discover({ environment, launchedAt }) {
    const configDir = environment.CODEX_HOME
      ? path.resolve(environment.CODEX_HOME)
      : path.join(homeDirectory(environment), ".codex");
    const roots = recentDateDirectories(path.join(configDir, "sessions"));
    const candidates = (await Promise.all(roots.map(async (directory) =>
      recentFiles(directory, (name) => /\.jsonl(?:\.zst)?$/i.test(name), launchedAt),
    ))).flat().sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime());
    return candidates.flatMap((candidate) => {
      const id = extractCodexThreadId(candidate.name);
      return id ? [{ id, sourcePath: candidate.path, modifiedAt: candidate.modifiedAt, confidence: "observed" as const }] : [];
    });
  },
  resumeCommand(profile, id) {
    return `${profile.invocation} resume ${id}`;
  },
};

function optionValue(args: readonly string[], names: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    for (const name of names) {
      if (value === name) {
        const next = args[index + 1];
        return next && !next.startsWith("-") ? next : null;
      }
      if (value.startsWith(`${name}=`)) {
        return value.slice(name.length + 1) || null;
      }
    }
  }
  return null;
}

function homeDirectory(environment: Readonly<Record<string, string>>): string {
  return environment.HOME || environment.USERPROFILE || os.homedir();
}

interface FileCandidate {
  name: string;
  path: string;
  modifiedAt: Date;
}

async function recentFiles(
  directory: string,
  include: (name: string) => boolean,
  launchedAt: Date,
): Promise<FileCandidate[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const minimum = launchedAt.getTime() - 90_000;
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && include(entry.name))
      .map(async (entry) => {
        const sourcePath = path.join(directory, entry.name);
        const stat = await fs.stat(sourcePath);
        return { name: entry.name, path: sourcePath, modifiedAt: stat.mtime };
      }));
    return files
      .filter((file) => file.modifiedAt.getTime() >= minimum)
      .sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime());
  } catch {
    return [];
  }
}

function recentDateDirectories(root: string): string[] {
  const now = new Date();
  const values: string[] = [];
  for (let offset = 0; offset <= 1; offset += 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    values.push(path.join(
      root,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ));
  }
  return values;
}

function extractCodexThreadId(name: string): string | null {
  const match = name.match(/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?:\.jsonl(?:\.zst)?)?$/i);
  return match?.[1]?.toLowerCase() ?? null;
}
