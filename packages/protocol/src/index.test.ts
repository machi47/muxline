import { describe, expect, it } from "vitest";
import {
  ClientTerminalMessageSchema,
  CreateSessionRequestSchema,
  PROTOCOL_VERSION,
  parseJsonMessage,
} from "./index.js";

describe("protocol validation", () => {
  it("accepts a valid terminal resize", () => {
    expect(
      parseJsonMessage(ClientTerminalMessageSchema, '{"type":"resize","cols":120,"rows":40}'),
    ).toEqual({ type: "resize", cols: 120, rows: 40 });
  });

  it("rejects unsafe dimensions", () => {
    expect(() =>
      ClientTerminalMessageSchema.parse({ type: "resize", cols: 0, rows: 40 }),
    ).toThrow();
  });

  it("does not reinterpret argv as a shell string", () => {
    const request = CreateSessionRequestSchema.parse({
      profile: "codex",
      command: "/opt/bin/codex",
      args: ["--prompt", "$(touch /tmp/should-not-run)", "a;b", "--"],
      cwd: "/tmp/project",
      env: { TERM: "xterm-256color" },
      cols: 80,
      rows: 24,
      term: "xterm-256color",
    });

    expect(request.args).toEqual(["--prompt", "$(touch /tmp/should-not-run)", "a;b", "--"]);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
