import { promises as fs } from "node:fs";
import path from "node:path";
import staticPlugin from "@fastify/static";
import websocket from "@fastify/websocket";
import { AttachmentRequestSchema } from "@muxline/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import type pino from "pino";
import { WebSocket } from "ws";
import {
  assertSameOrigin,
  authenticateAgent,
  authenticateWebRequest,
  authenticateWebSocketIdentity,
} from "./auth.js";
import { AttachmentNonceStore } from "./attachment-nonces.js";
import type { HubConfig } from "./config.js";
import { HubCatalog } from "./catalog.js";
import { HubRegistry } from "./registry.js";

export interface HubServer {
  app: FastifyInstance;
  start(): Promise<void>;
  close(): Promise<void>;
}

export async function createHubServer(
  config: HubConfig,
  logger: pino.Logger,
): Promise<HubServer> {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  const catalog = new HubCatalog(config.dataDir);
  await catalog.initialize();
  const registry = new HubRegistry(logger, catalog);
  const nonces = new AttachmentNonceStore();
  await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' wss: ws:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = errorMessage(error);
    const unauthorized = /Unauthorized|not allowed|Origin|Cross-site|Cross-origin/.test(message);
    logger.warn({ err: error }, "Hub request rejected");
    void reply.code(unauthorized ? 403 : 400).send({ error: message });
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/v1/agent", { websocket: true }, (socket, request) => {
    if (!authenticateAgent(request, config)) {
      socket.close(1008, "Unauthorized agent");
      return;
    }
    const claimedHostId = request.headers["x-muxline-host-id"];
    if (typeof claimedHostId !== "string") {
      socket.close(1008, "Missing host identity");
      return;
    }
    registry.connectAgent(socket, claimedHostId);
  });

  app.get("/v1/sessions", async (request) => {
    const identity = authenticateWebRequest(request, config);
    return { identity, hosts: registry.listHosts() };
  });

  app.post("/v1/attachments", async (request, reply) => {
    assertSameOrigin(request, config);
    const identity = authenticateWebRequest(request, config);
    const attachment = AttachmentRequestSchema.parse(request.body);
    if (!registry.hasOnlineSession(attachment.hostId, attachment.sessionId)) {
      return reply.code(409).send({ error: "Host or session is offline" });
    }
    return reply.code(201).send(
      nonces.create(identity.id, attachment.hostId, attachment.sessionId),
    );
  });

  app.get<{ Params: { hostId: string; sessionId: string } }>(
    "/v1/sessions/:hostId/:sessionId/snapshot",
    async (request, reply) => {
      authenticateWebRequest(request, config);
      const snapshot = await registry.snapshot(request.params.hostId, request.params.sessionId);
      if (!snapshot) return reply.code(404).send({ error: "No saved screen for this session" });
      return reply.send(snapshot);
    },
  );

  app.get("/v1/terminal", { websocket: true }, (socket, request) => {
    try {
      assertSameOrigin(request, config);
      const identity = authenticateWebSocketIdentity(request, config);
      const nonce = extractNonceProtocol(request.headers["sec-websocket-protocol"]);
      const grant = nonce ? nonces.consume(nonce, identity?.id) : null;
      if (!grant) {
        socket.close(1008, "Invalid or expired attachment grant");
        return;
      }
      registry.attachBrowser(socket, grant);
    } catch (error) {
      logger.warn({ err: error }, "Terminal WebSocket rejected");
      socket.close(1008, "Unauthorized terminal connection");
    }
  });

  if (await directoryExists(config.webDist)) {
    await app.register(staticPlugin, {
      root: config.webDist,
      prefix: "/",
      wildcard: false,
      index: ["index.html"],
      cacheControl: false,
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && request.headers.accept?.includes("text/html")) {
        return reply.type("text/html").sendFile("index.html");
      }
      return reply.code(404).send({ error: "Not found" });
    });
  } else {
    app.get("/", async (_request, reply) =>
      reply.type("text/plain").send("Muxline web build is missing. Run npm run build.\n")
    );
  }

  return {
    app,
    async start() {
      await app.listen({ host: config.bindHost, port: config.port });
      logger.info(
        { host: config.bindHost, port: config.port, authMode: config.authMode },
        "Muxline hub is listening",
      );
    },
    async close() {
      await registry.close();
      await app.close();
    },
  };
}

function extractNonceProtocol(header: string | string[] | undefined): string | null {
  const protocols = (Array.isArray(header) ? header.join(",") : header ?? "")
    .split(",")
    .map((value) => value.trim());
  const prefix = "muxline.nonce.";
  const protocol = protocols.find((value) => value.startsWith(prefix));
  return protocol ? protocol.slice(prefix.length) : null;
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await fs.stat(path.resolve(directory))).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown request error";
}
