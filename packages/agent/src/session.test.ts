import type { IPty } from "node-pty";
import { describe, expect, it } from "vitest";
import { ManagedSession } from "./session.js";
import type { TerminalMirror } from "./terminal-mirror.js";

class FakePty {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  #onData: ((data: string) => void) | undefined;
  #onExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;

  onData(listener: (data: string) => void) {
    this.#onData = listener;
    return { dispose() {} };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.#onExit = listener;
    return { dispose() {} };
  }
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.resizes.push([cols, rows]); }
  kill() { this.#onExit?.({ exitCode: 1, signal: 15 }); }
  output(data: string) { this.#onData?.(data); }
  exit(code: number) { this.#onExit?.({ exitCode: code }); }
}

class FakeMirror implements TerminalMirror {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.resizes.push([cols, rows]); }
  async snapshot() { return "initial screen"; }
  dispose() {}
}

describe("ManagedSession", () => {
  it("fans output out while enforcing one controller and one resizer", async () => {
    const pty = new FakePty();
    const mirror = new FakeMirror();
    const desktopMessages: Array<{ type: string; [key: string]: unknown }> = [];
    const phoneMessages: Array<{ type: string; [key: string]: unknown }> = [];
    const session = new ManagedSession({
      summary: {
        id: "11111111-1111-4111-8111-111111111111",
        revision: 1,
        hostId: "22222222-2222-4222-8222-222222222222",
        hostName: "mac",
        profile: {
          id: "codex",
          label: "codex",
          harness: "codex",
          provider: null,
          invocation: "codex",
        },
        workspace: {
          id: "workspace-00000001",
          path: "/Users/me/project",
          label: "project",
          gitRoot: null,
          repository: null,
        },
        displayName: "codex · project",
        nativeSession: {
          harness: "codex",
          id: null,
          status: "unresolved",
          confidence: "none",
          title: null,
          sourcePath: null,
          updatedAt: null,
          resumeCommand: null,
        },
        state: "live",
        runtimeId: "33333333-3333-4333-8333-333333333333",
        startedAt: "2026-01-01T00:00:00.000Z",
        lastOutputAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
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
      },
      pty: pty as unknown as IPty,
      mirror,
      onChanged() {},
    });

    await session.attach("desktop", "local", (message) => desktopMessages.push(message));
    session.handleClientMessage("desktop", { type: "claim-control", force: false });
    session.handleClientMessage("desktop", { type: "input", data: "hello" });
    session.handleClientMessage("desktop", { type: "resize", cols: 120, rows: 40 });
    expect(pty.writes).toEqual(["hello"]);
    expect(pty.resizes).toEqual([[120, 40]]);

    await session.attach("phone", "remote", (message) => phoneMessages.push(message));
    session.handleClientMessage("phone", { type: "input", data: "blocked" });
    expect(pty.writes).toEqual(["hello"]);
    expect(phoneMessages.at(-1)).toMatchObject({ type: "error", code: "CONTROL_REQUIRED" });

    session.handleClientMessage("phone", { type: "claim-control", force: true });
    session.handleClientMessage("phone", { type: "input", data: "from phone" });
    pty.output("answer");
    expect(pty.writes).toEqual(["hello", "from phone"]);
    expect(desktopMessages.at(-1)).toMatchObject({ type: "output", data: "answer" });
    expect(phoneMessages.at(-1)).toMatchObject({ type: "output", data: "answer" });

    pty.exit(7);
    expect(phoneMessages.at(-1)).toMatchObject({ type: "exit", exitCode: 7 });
    expect(session.summary()).toMatchObject({ state: "saved", exitCode: 7, cols: 120, rows: 40 });
  });
});
