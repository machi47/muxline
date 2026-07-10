import pino from "pino";
import { describe, expect, it } from "vitest";
import type { HubConfig } from "./config.js";
import { createHubServer } from "./server.js";

const config: HubConfig = {
  bindHost: "127.0.0.1",
  port: 7338,
  authMode: "dev",
  agentToken: "a".repeat(32),
  allowedTailnetUsers: new Set(),
  webDist: "/definitely/not/a/web/build",
  logLevel: "silent",
};

describe("hub HTTP surface", () => {
  it("returns health and an empty authenticated host inventory", async () => {
    const server = await createHubServer(config, pino({ level: "silent" }));
    const health = await server.app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });

    const sessions = await server.app.inject({ method: "GET", url: "/v1/sessions" });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toMatchObject({ hosts: [], identity: { id: "local-development" } });
    await server.close();
  });

  it("requires same-origin metadata before issuing attachment grants", async () => {
    const server = await createHubServer(config, pino({ level: "silent" }));
    const response = await server.app.inject({
      method: "POST",
      url: "/v1/attachments",
      payload: {
        hostId: "11111111-1111-4111-8111-111111111111",
        sessionId: "22222222-2222-4222-8222-222222222222",
      },
    });
    expect(response.statusCode).toBe(403);
    await server.close();
  });
});
