import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionSummary } from "@muxline/protocol";
import { HubCatalog } from "./catalog.js";

const HOST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const createdDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

function sessionFixture(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: SESSION_ID,
    revision: 7,
    hostId: HOST_ID,
    hostName: "windows-workstation",
    profile: {
      id: "codex-claude",
      label: "Codex / Claude",
      harness: "codex",
      provider: "Claude",
      invocation: "codex-claude",
    },
    workspace: {
      id: "workspace-76543210",
      path: "C:\\code\\muxline",
      label: "muxline",
      gitRoot: "C:\\code\\muxline",
      repository: "machi47/muxline",
    },
    displayName: "Codex / Claude · muxline",
    nativeSession: {
      harness: "codex",
      id: "native-codex-session",
      status: "linked",
      confidence: "exact",
      title: null,
      sourcePath: "C:\\Users\\me\\.codex\\sessions\\fixture.jsonl",
      updatedAt: "2026-07-10T12:00:00.000Z",
      resumeCommand: "codex-claude resume native-codex-session",
    },
    state: "saved",
    runtimeId: null,
    startedAt: "2026-07-10T11:00:00.000Z",
    lastOutputAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
    endedAt: "2026-07-10T12:00:00.000Z",
    reboundAt: null,
    exitCode: 0,
    signal: null,
    cols: 120,
    rows: 40,
    sequence: 31,
    snapshot: { available: false, capturedAt: null, bytes: 0, sequence: 0 },
    viewers: 0,
    controller: null,
    ...overrides,
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

describe("HubCatalog", () => {
  it("keeps host inventory, logical sessions, and last rendered screens after a hub restart", async () => {
    const dataDir = await temporaryDirectory("muxline-catalog-");
    const catalog = new HubCatalog(dataDir);
    await catalog.initialize();
    catalog.upsertHost({
      id: HOST_ID,
      name: "windows-workstation",
      platform: "win32",
      agentVersion: "0.1.0",
    });
    const session = sessionFixture();
    catalog.upsertSession(session);
    const screen = "\u001b[?25lSaved Codex screen";
    await catalog.saveSnapshot({
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      revision: session.revision,
      capturedAt: "2026-07-10T12:00:01.000Z",
      sequence: session.sequence,
      data: screen,
    });
    await catalog.close();

    const reopened = new HubCatalog(dataDir);
    await reopened.initialize();
    expect(reopened.hosts()).toEqual([expect.objectContaining({
      id: HOST_ID,
      name: "windows-workstation",
      sessions: [expect.objectContaining({
        id: SESSION_ID,
        state: "saved",
        profile: expect.objectContaining({ id: "codex-claude", harness: "codex" }),
        workspace: expect.objectContaining({ path: "C:\\code\\muxline" }),
        snapshot: {
          available: true,
          capturedAt: "2026-07-10T12:00:01.000Z",
          bytes: Buffer.byteLength(screen, "utf8"),
          sequence: 31,
        },
      })],
    })]);
    expect(await reopened.snapshot(HOST_ID, SESSION_ID)).toBe(screen);
    await reopened.close();
  });

  it("rejects stale session and screen updates so an older agent frame cannot overwrite a newer saved record", async () => {
    const dataDir = await temporaryDirectory("muxline-catalog-");
    const catalog = new HubCatalog(dataDir);
    await catalog.initialize();
    catalog.upsertHost({
      id: HOST_ID,
      name: "windows-workstation",
      platform: "win32",
      agentVersion: "0.1.0",
    });
    const newest = sessionFixture({ revision: 9, updatedAt: "2026-07-10T12:09:00.000Z" });
    catalog.upsertSession(newest);
    catalog.upsertSession(sessionFixture({
      revision: 8,
      state: "live",
      runtimeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      endedAt: null,
      exitCode: null,
      updatedAt: "2026-07-10T12:08:00.000Z",
    }));
    await catalog.saveSnapshot({
      hostId: HOST_ID,
      sessionId: SESSION_ID,
      revision: 8,
      capturedAt: "2026-07-10T12:08:00.000Z",
      sequence: 30,
      data: "stale screen",
    });

    expect(catalog.session(HOST_ID, SESSION_ID)).toMatchObject({
      revision: 9,
      state: "saved",
      runtimeId: null,
      snapshot: { available: false },
    });
    expect(await catalog.snapshot(HOST_ID, SESSION_ID)).toBeNull();
    await catalog.close();
  });
});
