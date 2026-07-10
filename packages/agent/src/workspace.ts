import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Workspace } from "@muxline/protocol";

const execFileAsync = promisify(execFile);

export async function describeWorkspace(hostId: string, cwd: string): Promise<Workspace> {
  const canonicalPath = await canonicalize(cwd);
  const gitRoot = await git(canonicalPath, ["rev-parse", "--show-toplevel"]);
  const remote = gitRoot ? await git(gitRoot, ["config", "--get", "remote.origin.url"]) : null;
  const label = path.basename(canonicalPath) || canonicalPath;
  return {
    id: createHash("sha256").update(`${hostId}\u0000${canonicalPath}`).digest("hex").slice(0, 32),
    path: canonicalPath,
    label,
    gitRoot,
    repository: remote ? repositoryLabel(remote) : null,
  };
}

async function canonicalize(cwd: string): Promise<string> {
  const resolved = path.resolve(cwd);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: 1_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

function repositoryLabel(remote: string): string {
  const normalized = remote.replace(/\/+$/, "");
  const last = normalized.slice(Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf(":")) + 1);
  return last.replace(/\.git$/i, "") || remote;
}
