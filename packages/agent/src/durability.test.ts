import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionSummary } from "@muxline/protocol";
import { AgentLedger } from "./ledger.js";
import { linkedNativeRef, nativeAdapterFor } from "./native-adapters.js";
import { resolveLaunchProfile } from "./profiles.js";

const HOST_ID = "22222222-2222-4222-8222-222222222222";
const LIVE_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SAVED_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

function sessionFixture(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: LIVE_SESSION_ID,
    revision: 4,
    hostId: HOST_ID,
    hostName: "studio-mac",
    profile: {
      id: "claude-glm",
      label: "Claude / GLM",
      harness: "claude-code",
      provider: "GLM",
      invocation: "claude-glm",
    },
    workspace: {
      id: "workspace-01234567",
      path: "/Users/me/code/muxline",
      label: "muxline",
      gitRoot: "/Users/me/code/muxline",
      repository: "machi47/muxline",
    },
    displayName: "Claude / GLM · muxline",
    nativeSession: {
      harness: "claude-code",
      id: "native-claude-session",
      status: "linked",
      confidence: "exact",
      title: null,
      sourcePath: "/Users/me/.claude/projects/-Users-me-code-muxline/native-claude-session.jsonl",
      updatedAt: "2026-07-10T12:00:00.000Z",
      resumeCommand: "claude-glm --resume native-claude-session",
    },
    state: "live",
    runtimeId: "44444444-4444-4444-8444-444444444444",
    startedAt: "2026-07-10T11:00:00.000Z",
    lastOutputAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
    endedAt: null,
    reboundAt: null,
    exitCode: null,
    signal: null,
    cols: 120,
    rows: 40,
    sequence: 17,
    snapshot: {
      available: true,
      capturedAt: "2026-07-10T12:00:00.000Z",
      bytes: 42,
      sequence: 17,
    },
    viewers: 2,
    controller: {
      clientId: "phone",
      source: "remote",
      acquiredAt: "2026-07-10T12:00:00.000Z",
      expiresAt: "2026-07-10T12:01:00.000Z",
    },
    ...overrides,
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

describe("AgentLedger", () => {
  it("persists a logical record, lifecycle event, and last rendered screen across instances", async () => {
    const dataDir = await temporaryDirectory("muxline-ledger-");
    const ledger = new AgentLedger(dataDir);
    const original = sessionFixture();

    const saved = await ledger.save(original, "created", "transparent launch");
    const snapshot = "\u001b[2J\u001b[HClaude is working…";
    const persistedSnapshot = await ledger.saveSnapshot(original.id, snapshot);
    expect(persistedSnapshot.bytes).toBe(Buffer.byteLength(snapshot, "utf8"));
    expect(path.basename(persistedSnapshot.path)).toBe(`${original.id}.ansi`);
    expect(path.basename(path.dirname(persistedSnapshot.path))).toBe("snapshots");
    expect(saved.events).toHaveLength(1);
    expect(saved.events[0]).toMatchObject({ kind: "created", detail: "transparent launch" });

    const reopened = new AgentLedger(dataDir);
    expect(await reopened.get(original.id)).toMatchObject({
      version: 1,
      session: {
        id: original.id,
        profile: { id: "claude-glm", harness: "claude-code", provider: "GLM" },
        workspace: { path: "/Users/me/code/muxline" },
        nativeSession: { id: "native-claude-session", status: "linked" },
      },
    });
    expect(await reopened.snapshot(original.id)).toBe(snapshot);
  });

  it("marks only live records interrupted when reopening after an agent disappearance", async () => {
    const dataDir = await temporaryDirectory("muxline-ledger-");
    const first = new AgentLedger(dataDir);
    const live = sessionFixture();
    const alreadySaved = sessionFixture({
      id: SAVED_SESSION_ID,
      state: "saved",
      runtimeId: null,
      endedAt: "2026-07-10T12:03:00.000Z",
      viewers: 0,
      controller: null,
    });
    await first.save(live, "created");
    await first.save(alreadySaved, "saved");
    await first.saveSnapshot(live.id, "last live screen");

    const reopened = new AgentLedger(dataDir);
    const changed = await reopened.markPreviouslyLiveInterrupted();
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      session: {
        id: LIVE_SESSION_ID,
        revision: live.revision + 1,
        state: "interrupted",
        runtimeId: null,
        viewers: 0,
        controller: null,
      },
      events: expect.arrayContaining([expect.objectContaining({ kind: "interrupted" })]),
    });
    expect(changed[0]?.session.endedAt).toEqual(expect.any(String));

    expect(await reopened.get(SAVED_SESSION_ID)).toMatchObject({
      session: {
        id: SAVED_SESSION_ID,
        revision: alreadySaved.revision,
        state: "saved",
        runtimeId: null,
      },
    });
    expect(await reopened.snapshot(LIVE_SESSION_ID)).toBe("last live screen");
  });
});

describe("launch profiles and native adapters", () => {
  it("classifies aliases as a harness plus a provider/mode without treating aliases as new harnesses", () => {
    expect(resolveLaunchProfile("claude-glm", "claude", {})).toEqual({
      id: "claude-glm",
      label: "claude-glm",
      harness: "claude-code",
      provider: "GLM",
      invocation: "claude-glm",
    });
    expect(resolveLaunchProfile("codex-claude", "codex", {})).toEqual({
      id: "codex-claude",
      label: "codex-claude",
      harness: "codex",
      provider: "Claude",
      invocation: "codex-claude",
    });
    expect(resolveLaunchProfile("routing-shell", "/tools/claude", {
      "routing-shell": { harness: "codex", label: "Codex through router", provider: "GLM" },
    })).toMatchObject({
      id: "routing-shell",
      label: "Codex through router",
      harness: "codex",
      provider: "GLM",
    });
  });

  it("recognizes explicit native resume hints and produces the profile-specific re-entry command", () => {
    const claude = nativeAdapterFor("claude-code");
    const codex = nativeAdapterFor("codex");
    const claudeProfile = resolveLaunchProfile("claude-glm", "claude", {});
    const codexProfile = resolveLaunchProfile("codex-claude", "codex", {});
    expect(claude).not.toBeNull();
    expect(codex).not.toBeNull();
    expect(claude?.launchHint(["--resume", "claude-native-id"])).toBe("claude-native-id");
    expect(claude?.launchHint(["--session-id=claude-native-id"])).toBe("claude-native-id");
    expect(codex?.launchHint(["resume", "codex-native-id"])).toBe("codex-native-id");
    expect(codex?.launchHint(["--resume=codex-native-id"])).toBe("codex-native-id");
    expect(nativeAdapterFor("generic")).toBeNull();

    expect(linkedNativeRef(claude!, claudeProfile, {
      id: "claude-native-id",
      sourcePath: "/tmp/claude.jsonl",
      modifiedAt: new Date("2026-07-10T12:00:00.000Z"),
      confidence: "observed",
    })).toMatchObject({
      harness: "claude-code",
      id: "claude-native-id",
      status: "linked",
      confidence: "observed",
      resumeCommand: "claude-glm --resume claude-native-id",
    });
    expect(codex?.resumeCommand(codexProfile, "codex-native-id")).toBe(
      "codex-claude resume codex-native-id",
    );
  });

  it("discovers recent Claude and Codex session artifacts from isolated fixture homes", async () => {
    const dataDir = await temporaryDirectory("muxline-native-");
    const claudeHome = path.join(dataDir, "claude-home");
    const codexHome = path.join(dataDir, "codex-home");
    const cwd = "/Users/me/code/muxline";
    const claudeId = "claude-native-id";
    const claudePath = path.join(
      claudeHome,
      "projects",
      cwd.replace(/[^A-Za-z0-9]/g, "-"),
      `${claudeId}.jsonl`,
    );
    const now = new Date();
    const codexId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const codexPath = path.join(
      codexHome,
      "sessions",
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
      `rollout-${codexId}.jsonl`,
    );
    await fs.mkdir(path.dirname(claudePath), { recursive: true });
    await fs.mkdir(path.dirname(codexPath), { recursive: true });
    await Promise.all([
      fs.writeFile(claudePath, "{\"type\":\"fixture\"}\n"),
      fs.writeFile(codexPath, "{\"type\":\"fixture\"}\n"),
    ]);

    const launchedAt = new Date(Date.now() - 1_000);
    const claude = nativeAdapterFor("claude-code")!;
    const codex = nativeAdapterFor("codex")!;
    const [claudeCandidates, codexCandidates] = await Promise.all([
      claude.discover({
        profile: resolveLaunchProfile("claude-glm", "claude", {}),
        cwd,
        environment: { CLAUDE_CONFIG_DIR: claudeHome },
        launchedAt,
      }),
      codex.discover({
        profile: resolveLaunchProfile("codex", "codex", {}),
        cwd,
        environment: { CODEX_HOME: codexHome },
        launchedAt,
      }),
    ]);

    expect(claudeCandidates).toEqual([expect.objectContaining({
      id: claudeId,
      sourcePath: claudePath,
      confidence: "observed",
    })]);
    expect(codexCandidates).toEqual([expect.objectContaining({
      id: codexId,
      sourcePath: codexPath,
      confidence: "observed",
    })]);
  });
});
