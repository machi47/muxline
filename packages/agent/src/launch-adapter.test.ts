import { describe, expect, it } from "vitest";
import { buildLaunchSpec, windowsLaunchScriptForTest } from "./launch-adapter.js";

describe("buildLaunchSpec", () => {
  it("preserves POSIX argv without a shell", () => {
    const result = buildLaunchSpec(
      "/usr/local/bin/codex",
      ["--prompt", "a; touch /tmp/no", "$(whoami)", "雪"],
      { PATH: "/usr/bin" },
      "darwin",
    );
    expect(result.command).toBe("/usr/local/bin/codex");
    expect(result.args).toEqual(["--prompt", "a; touch /tmp/no", "$(whoami)", "雪"]);
    expect(result.env.MUXLINE_WRAPPED).toBe("1");
  });

  it("passes Windows script argv as encoded JSON instead of source text", () => {
    const result = buildLaunchSpec(
      "C:\\Program Files\\Claude\\claude.cmd",
      ["--flag=a&calc.exe", "%PATH%", "hello world", "雪"],
      { SystemRoot: "C:\\Windows" },
      "win32",
    );
    const decoded = JSON.parse(
      Buffer.from(result.env.MUXLINE_WINDOWS_LAUNCH_B64 ?? "", "base64").toString("utf8"),
    ) as string[];
    expect(decoded).toEqual([
      "C:\\Program Files\\Claude\\claude.cmd",
      "--flag=a&calc.exe",
      "%PATH%",
      "hello world",
      "雪",
    ]);
    expect(result.args.join(" ")).not.toContain("calc.exe");
    expect(windowsLaunchScriptForTest).toContain("ConvertFrom-Json");
  });

  it("rejects values that cannot be represented safely", () => {
    expect(() => buildLaunchSpec("codex", ["bad\narg"], {}, "linux")).toThrow();
  });
});
