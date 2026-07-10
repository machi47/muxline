import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const AuthModeSchema = z.enum(["dev", "tailscale", "token"]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

export interface HubConfig {
  bindHost: string;
  port: number;
  authMode: AuthMode;
  agentToken: string;
  webToken?: string;
  allowedTailnetUsers: ReadonlySet<string>;
  dataDir: string;
  webDist: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export function loadHubConfig(environment: NodeJS.ProcessEnv = process.env): HubConfig {
  const authMode = AuthModeSchema.parse(environment.MUXLINE_AUTH_MODE ?? "dev");
  const bindHost = environment.MUXLINE_BIND_HOST ?? "127.0.0.1";
  if (bindHost !== "127.0.0.1" && bindHost !== "::1" && environment.MUXLINE_ALLOW_NON_LOOPBACK !== "1") {
    throw new Error(
      "Muxline hub must bind to loopback. Put Tailscale Serve in front of it instead of exposing it directly.",
    );
  }
  const agentToken = environment.MUXLINE_HUB_AGENT_TOKEN
    ?? (authMode === "dev" ? "development-agent-token-change-me" : "");
  if (agentToken.length < 16) {
    throw new Error("MUXLINE_HUB_AGENT_TOKEN must contain at least 16 characters");
  }
  const webToken = environment.MUXLINE_WEB_TOKEN;
  if (authMode === "token" && (!webToken || webToken.length < 24)) {
    throw new Error("Token auth requires MUXLINE_WEB_TOKEN with at least 24 characters");
  }
  const allowedTailnetUsers = new Set(
    (environment.MUXLINE_ALLOWED_TAILSCALE_USERS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (authMode === "tailscale" && allowedTailnetUsers.size === 0) {
    throw new Error(
      "Tailscale auth requires an explicit MUXLINE_ALLOWED_TAILSCALE_USERS allowlist",
    );
  }

  const logLevel = z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .parse(environment.MUXLINE_LOG_LEVEL ?? "info");
  const port = z.coerce.number().int().min(1024).max(65_535)
    .parse(environment.MUXLINE_HUB_PORT ?? "7338");
  const defaultWebDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  return {
    bindHost,
    port,
    authMode,
    agentToken,
    ...(webToken ? { webToken } : {}),
    allowedTailnetUsers,
    dataDir: environment.MUXLINE_HUB_HOME
      ? path.resolve(environment.MUXLINE_HUB_HOME)
      : path.join(os.homedir(), ".muxline-hub"),
    webDist: environment.MUXLINE_WEB_DIST ?? defaultWebDist,
    logLevel,
  };
}
