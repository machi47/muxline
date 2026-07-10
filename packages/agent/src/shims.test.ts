import { describe, expect, it } from "vitest";
import { posixShim, windowsShim } from "./shims.js";

describe("command shims", () => {
  it("quotes POSIX executable paths without consuming user flags", () => {
    const shim = posixShim("claude-glm", "/Users/me/My Tools/claude'");
    expect(shim).toContain("--profile 'claude-glm' --");
    expect(shim).toContain("\"$@\"");
    expect(shim).toContain("'\"'\"'");
  });

  it("forwards Windows shim arguments", () => {
    const shim = windowsShim("codex", "C:\\Tools\\codex.cmd");
    expect(shim).toContain('muxline run --profile "codex"');
    expect(shim).toContain("%*");
    expect(shim).toContain("exit /b %ERRORLEVEL%");
  });
});
