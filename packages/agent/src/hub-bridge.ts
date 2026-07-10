import { randomUUID } from "node:crypto";
import {
  HubToAgentMessageSchema,
  PROTOCOL_VERSION,
  encodeMessage,
  parseJsonMessage,
  type AgentToHubMessage,
  type ServerTerminalMessage,
} from "@muxline/protocol";
import type pino from "pino";
import WebSocket from "ws";
import type { AgentConfig } from "./config.js";
import type { SessionManager } from "./session-manager.js";

interface RemoteTunnel {
  sessionId: string;
  clientId: string;
}

export class HubBridge {
  readonly #config: AgentConfig;
  readonly #sessions: SessionManager;
  readonly #logger: pino.Logger;
  readonly #tunnels = new Map<string, RemoteTunnel>();
  #socket: WebSocket | null = null;
  #stopping = false;
  #attempt = 0;
  #retryTimer: NodeJS.Timeout | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #removeSessionListener: (() => void) | null = null;
  #removeSnapshotListener: (() => void) | null = null;

  public constructor(config: AgentConfig, sessions: SessionManager, logger: pino.Logger) {
    this.#config = config;
    this.#sessions = sessions;
    this.#logger = logger;
  }

  public start(): void {
    if (!this.#config.hubUrl || !this.#config.hubToken) {
      this.#logger.info("No hub configured; local persistent sessions remain available");
      return;
    }
    this.#stopping = false;
    this.#removeSessionListener = this.#sessions.onUpsert((session) => {
      this.#send({ type: "session-upsert", session });
    });
    this.#removeSnapshotListener = this.#sessions.onSnapshot((session, data) => {
      const capturedAt = session.snapshot.capturedAt;
      if (!capturedAt) return;
      this.#send({
        type: "session-snapshot",
        hostId: this.#config.hostId,
        sessionId: session.id,
        revision: session.revision,
        capturedAt,
        sequence: session.snapshot.sequence,
        data,
      });
    });
    this.#connect();
  }

  public stop(): void {
    this.#stopping = true;
    this.#removeSessionListener?.();
    this.#removeSessionListener = null;
    this.#removeSnapshotListener?.();
    this.#removeSnapshotListener = null;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#socket?.close(1000, "Agent stopping");
    this.#socket = null;
    this.#detachAll();
  }

  #connect(): void {
    if (this.#stopping || !this.#config.hubUrl || !this.#config.hubToken) {
      return;
    }
    const url = new URL("/v1/agent", this.#config.hubUrl);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";

    const socket = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${this.#config.hubToken}`,
        "x-muxline-host-id": this.#config.hostId,
      },
      maxPayload: 2 * 1024 * 1024,
      handshakeTimeout: 15_000,
    });
    this.#socket = socket;

    socket.on("open", () => {
      this.#attempt = 0;
      this.#logger.info({ hub: url.origin }, "Connected to Muxline hub");
      this.#send({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        hostId: this.#config.hostId,
        hostName: this.#config.hostName,
        platform: `${process.platform}-${process.arch}`,
        agentVersion: "0.1.0",
      });
      this.#send({ type: "session-list", sessions: this.#sessions.list() });
      void this.#publishSnapshots();
      this.#heartbeatTimer = setInterval(
        () => this.#send({ type: "heartbeat", at: Date.now() }),
        15_000,
      );
      this.#heartbeatTimer.unref();
    });

    socket.on("message", (data) => {
      try {
        const message = parseJsonMessage(HubToAgentMessageSchema, data);
        void this.#handleMessage(message);
      } catch (error) {
        this.#logger.warn({ err: error }, "Rejected message from hub");
        socket.close(1008, "Invalid protocol message");
      }
    });

    socket.on("close", () => {
      if (this.#socket === socket) {
        this.#socket = null;
      }
      if (this.#heartbeatTimer) {
        clearInterval(this.#heartbeatTimer);
        this.#heartbeatTimer = null;
      }
      this.#detachAll();
      this.#scheduleReconnect();
    });
    socket.on("error", (error) => {
      this.#logger.warn({ err: error }, "Hub connection error");
    });
  }

  async #handleMessage(message: ReturnType<typeof HubToAgentMessageSchema.parse>): Promise<void> {
    switch (message.type) {
      case "attach": {
        const session = this.#sessions.get(message.sessionId);
        if (!session) {
          this.#sendTerminal(message.tunnelId, {
            type: "error",
            code: "SESSION_NOT_FOUND",
            message: "The requested session is not available on this host",
          });
          return;
        }
        const clientId = `remote:${message.clientId}:${randomUUID()}`;
        this.#tunnels.set(message.tunnelId, { sessionId: message.sessionId, clientId });
        try {
          await session.attach(clientId, "remote", (terminalMessage) => {
            this.#sendTerminal(message.tunnelId, terminalMessage);
          });
        } catch (error) {
          this.#tunnels.delete(message.tunnelId);
          this.#logger.warn({ err: error, sessionId: message.sessionId }, "Remote attach failed");
          this.#sendTerminal(message.tunnelId, {
            type: "error",
            code: "ATTACH_FAILED",
            message: "Unable to attach to the session",
          });
        }
        return;
      }
      case "detach": {
        this.#detachTunnel(message.tunnelId);
        return;
      }
      case "terminal-message": {
        const tunnel = this.#tunnels.get(message.tunnelId);
        if (!tunnel) {
          return;
        }
        this.#sessions.get(tunnel.sessionId)?.handleClientMessage(tunnel.clientId, message.message);
        return;
      }
      case "heartbeat": {
        this.#send({ type: "heartbeat", at: message.at });
        return;
      }
    }
  }

  #sendTerminal(tunnelId: string, message: ServerTerminalMessage): void {
    this.#send({ type: "terminal-message", tunnelId, message });
  }

  async #publishSnapshots(): Promise<void> {
    for (const session of this.#sessions.list()) {
      if (!session.snapshot.available || !session.snapshot.capturedAt) continue;
      try {
        const data = await this.#sessions.snapshot(session.id);
        if (!data) continue;
        this.#send({
          type: "session-snapshot",
          hostId: this.#config.hostId,
          sessionId: session.id,
          revision: session.revision,
          capturedAt: session.snapshot.capturedAt,
          sequence: session.snapshot.sequence,
          data,
        });
      } catch (error) {
        this.#logger.debug({ err: error, sessionId: session.id }, "Could not publish saved screen");
      }
    }
  }

  #send(message: AgentToHubMessage): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (socket.bufferedAmount > 8 * 1024 * 1024) {
      socket.close(1013, "Backpressure limit exceeded");
      return;
    }
    socket.send(encodeMessage(message));
  }

  #detachTunnel(tunnelId: string): void {
    const tunnel = this.#tunnels.get(tunnelId);
    if (!tunnel) return;
    this.#sessions.get(tunnel.sessionId)?.detach(tunnel.clientId);
    this.#tunnels.delete(tunnelId);
  }

  #detachAll(): void {
    for (const tunnelId of [...this.#tunnels.keys()]) {
      this.#detachTunnel(tunnelId);
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopping || this.#retryTimer) return;
    const base = Math.min(30_000, 500 * 2 ** Math.min(this.#attempt, 6));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.#attempt += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, delay);
    this.#retryTimer.unref();
  }
}
