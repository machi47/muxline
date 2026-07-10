import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@muxline/protocol";

class FakePty {
  #onData: ((data: string) => void) | undefined;
  #onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;

  public onData(listener: (data: string) => void) {
    this.#onData = listener;
    return { dispose() {} };
  }

  public onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.#onExit = listener;
    return { dispose() {} };
  }

  public readonly writes: string[] = [];
  public write(data: string) { this.writes.push(data); }
  public resize() {}
  public kill() { this.#onExit?.({ exitCode: 1, signal: 15 }); }
  public emit(data: string) { this.#onData?.(data); }
  public exit(code: number) { this.#onExit?.({ exitCode: code }); }
}

let spawned: FakePty | undefined;
let autoExit = true;

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    spawned = new FakePty();
    if (autoExit) {
      setTimeout(() => {
        spawned?.emit("runner survives supervisor\r\n");
        spawned?.exit(0);
      }, 15);
    }
    return spawned;
  }),
}));

const created: string[] = [];

afterEach(async () => {
  spawned = undefined;
  autoExit = true;
  await Promise.all(created.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function summary(): SessionSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    hostId: "22222222-2222-4222-8222-222222222222",
    hostName: "host",
    profile: { id: "terminal", label: "Terminal", harness: "generic", provider: null, invocation: "terminal" },
    workspace: { id: "workspace-00000001", path: "/tmp/project", label: "project", gitRoot: null, repository: null },
    displayName: "Terminal · project",
    nativeSession: { harness: "generic", id: null, status: "unresolved", confidence: "none", title: null, sourcePath: null, updatedAt: null, resumeCommand: null },
    state: "live",
    runtimeId: "33333333-3333-4333-8333-333333333333",
    startedAt: "2026-07-10T00:00:00.000Z",
    lastOutputAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    endedAt: null,
    reboundAt: null,
    exitCode: null,
    signal: null,
    cols: 80,
    rows: 24,
    sequence: 0,
    snapshot: { available: false, capturedAt: null, bytes: 0, sequence: 0 },
    viewers: 0,
    controller: null,
  };
}

describe("detached session runner", () => {
  it("owns a PTY lifecycle and leaves a saved screen in its private descriptor", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "muxline-runner-"));
    created.push(dataDir);
    const { RunnerStore } = await import("./runner-store.js");
    const { runSessionRunner } = await import("./runner-process.js");
    const store = new RunnerStore(dataDir);
    const record = summary();
    await store.save({
      version: 1,
      id: record.id,
      runtimeId: record.runtimeId!,
      token: randomBytes(32).toString("base64url"),
      pid: null,
      port: null,
      status: "starting",
      summary: record,
      launch: {
        command: process.execPath,
        args: [],
        cwd: dataDir,
        env: { PATH: process.env.PATH ?? "" },
        term: "xterm-256color",
        cols: 80,
        rows: 24,
      },
      updatedAt: "2026-07-10T00:00:00.000Z",
    });

    await runSessionRunner(store.path(record.id));

    expect(await store.get(record.id)).toMatchObject({
      status: "saved",
      summary: {
        state: "saved",
        exitCode: 0,
        runtimeId: null,
        snapshot: { available: true },
      },
    });
    expect(await store.snapshot(record.id)).toContain("runner survives supervisor");
  }, 10_000);

  it("continues to accept a second supervisor proxy after the first proxy disconnects", async () => {
    autoExit = false;
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "muxline-runner-reconnect-"));
    created.push(dataDir);
    const { RunnerStore } = await import("./runner-store.js");
    const { RunnerSession } = await import("./runner-client.js");
    const { runSessionRunner } = await import("./runner-process.js");
    const store = new RunnerStore(dataDir);
    const record = summary();
    await store.save({
      version: 1,
      id: record.id,
      runtimeId: record.runtimeId!,
      token: randomBytes(32).toString("base64url"),
      pid: null,
      port: null,
      status: "starting",
      summary: record,
      launch: {
        command: process.execPath,
        args: [],
        cwd: dataDir,
        env: { PATH: process.env.PATH ?? "" },
        term: "xterm-256color",
        cols: 80,
        rows: 24,
      },
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const runner = runSessionRunner(store.path(record.id));
    const manifest = await waitForManifest(store, record.id);
    const callbacks = { onSummary() {}, onSnapshot() {}, onUnavailable() {} };
    const first = await RunnerSession.connect(manifest, callbacks);
    const messages: string[] = [];
    await first.attach("desktop", "local", (message) => {
      if (message.type === "output") messages.push(message.data);
    });
    spawned?.emit("still running\r\n");
    await waitFor(() => messages.includes("still running\r\n"));
    first.dispose();

    const second = await RunnerSession.connect((await store.get(record.id))!, callbacks);
    expect(second.summary()).toMatchObject({ id: record.id, state: "live", runtimeId: record.runtimeId });
    await fetch(`http://127.0.0.1:${(await store.get(record.id))!.port}/v1/interrupt`, {
      method: "POST",
      headers: { authorization: `Bearer ${(await store.get(record.id))!.token}` },
    });
    await runner;
    expect(await store.get(record.id)).toMatchObject({ status: "interrupted", summary: { state: "interrupted" } });
  }, 10_000);
});

async function waitForManifest(
  store: InstanceType<typeof import("./runner-store.js").RunnerStore>,
  id: string,
) {
  let manifest = await store.get(id);
  await waitFor(async () => {
    manifest = await store.get(id);
    return Boolean(manifest?.port && manifest.status === "running");
  });
  if (!manifest) throw new Error("Missing runner manifest");
  return manifest;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out waiting for runner state");
}
