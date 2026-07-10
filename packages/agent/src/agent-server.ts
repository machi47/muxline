import { timingSafeEqual } from "node:crypto";
import websocket from "@fastify/websocket";
import {
  ClientTerminalMessageSchema,
  CreateSessionRequestSchema,
  encodeMessage,
  parseJsonMessage,
} from "@muxline/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type pino from "pino";
import { WebSocket } from "ws";
import type { AgentConfig } from "./config.js";
import type { SessionManager } from "./session-manager.js";

export interface AgentServer {
  app: FastifyInstance;
  start(): Promise<void>;
  close(): Promise<void>;
}

export async function createAgentServer(
  config: AgentConfig,
  sessions: SessionManager,
  logger: pino.Logger,
): Promise<AgentServer> {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });

  app.setErrorHandler((error, _request, reply) => {
    logger.warn({ err: error }, "Local agent request failed");
    void reply.code(400).send({ error: errorMessage(error) });
  });

  app.get("/health", async () => ({ ok: true, hostId: config.hostId }));

  app.get("/v1/sessions", { preHandler: localAuth(config) }, async () => ({
    sessions: sessions.list(),
  }));

  app.post("/v1/sessions", { preHandler: localAuth(config) }, async (request, reply) => {
    const payload = CreateSessionRequestSchema.parse(request.body);
    const session = sessions.create(payload);
    return reply.code(201).send({ session: session.summary() });
  });

  app.delete<{ Params: { id: string } }>(
    "/v1/sessions/:id",
    { preHandler: localAuth(config) },
    async (request, reply) => {
      const removed = sessions.remove(request.params.id);
      return reply.code(removed ? 204 : 409).send();
    },
  );

  app.get<{ Params: { id: string }; Querystring: { token?: string; clientId?: string } }>(
    "/v1/sessions/:id/terminal",
    { websocket: true },
    (socket, request) => {
      if (!secureEqual(request.query.token ?? "", config.localToken)) {
        socket.close(1008, "Unauthorized");
        return;
      }
      const clientId = request.query.clientId;
      if (!clientId || clientId.length > 200) {
        socket.close(1008, "Missing client ID");
        return;
      }
      const session = sessions.get(request.params.id);
      if (!session) {
        socket.close(1008, "Unknown session");
        return;
      }

      const send = (message: Parameters<typeof encodeMessage>[0]) => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }
        if (socket.bufferedAmount > 4 * 1024 * 1024) {
          socket.close(1013, "Client is too slow; reconnect to resynchronize");
          return;
        }
        socket.send(encodeMessage(message));
      };

      void session.attach(clientId, "local", send).catch((error: unknown) => {
        logger.warn({ err: error, sessionId: session.id }, "Local terminal attach failed");
        socket.close(1011, "Attach failed");
      });

      socket.on("message", (data) => {
        try {
          session.handleClientMessage(clientId, parseJsonMessage(ClientTerminalMessageSchema, data));
        } catch (error) {
          logger.debug({ err: error, sessionId: session.id }, "Rejected local terminal frame");
          socket.close(1008, "Invalid frame");
        }
      });
      socket.on("close", () => session.detach(clientId));
      socket.on("error", () => session.detach(clientId));
    },
  );

  return {
    app,
    async start() {
      await app.listen({ host: "127.0.0.1", port: config.localPort });
      logger.info({ port: config.localPort, hostId: config.hostId }, "Muxline agent is listening");
    },
    async close() {
      await app.close();
    },
  };
}

function localAuth(config: AgentConfig) {
  return async (request: FastifyRequest): Promise<void> => {
    const authorization = request.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!secureEqual(token, config.localToken)) {
      throw new Error("Unauthorized");
    }
  };
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown request error";
}
