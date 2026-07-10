import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "./config.js";

/**
 * Claude's documented `--plugin-dir` makes these hooks per-invocation. Nothing
 * in ~/.claude/settings.json, a project .claude directory, or the harness binary
 * is altered. The hook intentionally has no stdout/stderr side effects.
 */
export async function ensureClaudeHookPlugin(config: AgentConfig): Promise<string> {
  const root = path.join(config.dataDir, "claude-plugin");
  const manifestDir = path.join(root, ".claude-plugin");
  const hooksDir = path.join(root, "hooks");
  await Promise.all([
    fs.mkdir(manifestDir, { recursive: true, mode: 0o700 }),
    fs.mkdir(hooksDir, { recursive: true, mode: 0o700 }),
  ]);
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const sourceCliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const activeCli = await fileExists(cliPath) ? cliPath : sourceCliPath;
  const devLoader = activeCli.endsWith(".ts") ? " --import tsx" : "";
  const command = `${shellQuote(process.execPath)}${devLoader} ${shellQuote(activeCli)} claude-hook`;
  await Promise.all([
    atomicWrite(path.join(manifestDir, "plugin.json"), `${JSON.stringify({
      name: "muxline-session-bridge",
      version: "0.1.0",
      description: "Private Muxline lifecycle bridge; no Claude settings are modified.",
    }, null, 2)}\n`),
    atomicWrite(path.join(hooksDir, "hooks.json"), `${JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command }] }],
        SessionEnd: [{ hooks: [{ type: "command", command }] }],
      },
    }, null, 2)}\n`),
  ]);
  return root;
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll("\"", "\\\"")}"`;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function atomicWrite(target: string, data: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
