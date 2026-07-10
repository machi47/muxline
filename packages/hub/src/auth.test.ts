import { describe, expect, it } from "vitest";
import { assertSameOrigin, secureEqual } from "./auth.js";
import type { HubConfig } from "./config.js";

const config: HubConfig = {
  bindHost: "127.0.0.1",
  port: 7338,
  authMode: "tailscale",
  agentToken: "a".repeat(32),
  allowedTailnetUsers: new Set(["me@example.com"]),
  dataDir: "/tmp/muxline-hub-auth-test",
  webDist: "/tmp/none",
  logLevel: "silent",
};

describe("hub auth", () => {
  it("uses constant-length-safe token comparison", () => {
    expect(secureEqual("same", "same")).toBe(true);
    expect(secureEqual("same", "different")).toBe(false);
  });

  it("accepts only same-host HTTPS origins in Tailscale mode", () => {
    const valid = {
      headers: {
        origin: "https://muxline.example.ts.net",
        host: "muxline.example.ts.net",
        "sec-fetch-site": "same-origin",
      },
    };
    expect(() => assertSameOrigin(valid as never, config)).not.toThrow();
    expect(() =>
      assertSameOrigin(
        { headers: { ...valid.headers, origin: "https://evil.example" } } as never,
        config,
      ),
    ).toThrow(/Cross-origin/);
  });
});
