import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateAgentConfig, saveAgentHubConfig } from "./config.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("agent config", () => {
  it("creates stable host identity and local secret with restrictive mode", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "muxline-config-"));
    created.push(directory);
    const first = await loadOrCreateAgentConfig({ MUXLINE_HOME: directory });
    const second = await loadOrCreateAgentConfig({ MUXLINE_HOME: directory });
    expect(first.hostId).toBe(second.hostId);
    expect(first.localToken.length).toBeGreaterThanOrEqual(32);
    if (process.platform !== "win32") {
      const stat = await fs.stat(path.join(directory, "agent.json"));
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("persists hub enrollment for background startup", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "muxline-config-"));
    created.push(directory);
    const initial = await loadOrCreateAgentConfig({ MUXLINE_HOME: directory });
    await saveAgentHubConfig(initial, "https://hub.example.ts.net/", "x".repeat(32));
    const reloaded = await loadOrCreateAgentConfig({ MUXLINE_HOME: directory });
    expect(reloaded.hubUrl).toBe("https://hub.example.ts.net/");
    expect(reloaded.hubToken).toBe("x".repeat(32));
  });
});
