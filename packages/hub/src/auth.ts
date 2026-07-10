import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { HubConfig } from "./config.js";

export interface RequestIdentity {
  id: string;
  displayName: string;
}

export function authenticateWebRequest(
  request: FastifyRequest,
  config: HubConfig,
): RequestIdentity {
  switch (config.authMode) {
    case "dev":
      return { id: "local-development", displayName: "Local development" };
    case "token": {
      const authorization = request.headers.authorization ?? "";
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!config.webToken || !secureEqual(token, config.webToken)) {
        throw new Error("Unauthorized");
      }
      return { id: "token-user", displayName: "Token user" };
    }
    case "tailscale": {
      const login = header(request, "tailscale-user-login")?.toLowerCase();
      if (!login || !config.allowedTailnetUsers.has(login)) {
        throw new Error("This Tailscale identity is not allowed");
      }
      return {
        id: login,
        displayName: header(request, "tailscale-user-name") ?? login,
      };
    }
  }
}

export function authenticateWebSocketIdentity(
  request: FastifyRequest,
  config: HubConfig,
): RequestIdentity | null {
  if (config.authMode === "token") {
    return null;
  }
  return authenticateWebRequest(request, config);
}

export function assertSameOrigin(request: FastifyRequest, config: HubConfig): void {
  const originValue = request.headers.origin;
  const host = request.headers.host;
  if (!originValue || !host) {
    throw new Error("Missing Origin or Host header");
  }
  let origin: URL;
  try {
    origin = new URL(originValue);
  } catch {
    throw new Error("Invalid Origin header");
  }
  if (origin.host !== host) {
    throw new Error("Cross-origin requests are not allowed");
  }
  if (config.authMode === "tailscale" && origin.protocol !== "https:") {
    throw new Error("Tailscale mode requires HTTPS");
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    throw new Error("Invalid Origin scheme");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new Error("Cross-site requests are not allowed");
  }
}

export function authenticateAgent(request: FastifyRequest, config: HubConfig): boolean {
  const authorization = request.headers.authorization ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return secureEqual(token, config.agentToken);
}

export function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
