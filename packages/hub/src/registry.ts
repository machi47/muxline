import { randomUUID } from "node:crypto";
import {
  AgentToHubMessageSchema,
  ClientTerminalMessageSchema,
  encodeMessage,
  parseJsonMessage,
  type AgentToHubMessage,
  type HubToAgentMessage,
  type SessionSummary,
} from "@muxline/protocol";
import type pino from "pino";
import WebSocket, { type RawData } from "ws";
import type { AttachmentGrant } from "./attachment-nonces.js";

interface HostRecord {
  id: string;
  name: string;
  platform: string;
  agentVersion: string;
  socket: WebSocket | null;
  sessions: Map<string, SessionSummary>;
  connectedAt: string | null;
  lastSeenAt: string;
}

interface TunnelRecord {
  id: string;
  hostId: string;
  sessionId: string;
  clientId: string;
  socket: WebSocket;
}

export interface HostView {
  id: string;
  name: string;
  platform: string;
  agentVersion: string;
  online: boolean;
  connectedAt: string | null;
  lastSeenAt: string;
  sessions: SessionSummary[];
}

export class HubRegistry {
  readonly #logger: pino.Logger;
  readonly #hosts = new Map<string, HostRecord>();
  readonly #tunnels = new Map<string, TunnelRecord>();

  public constructor(logger: pino.Logger) {
    this.#logger = logger;
  }

  public connectAgent(socket: WebSocket, claimedHostId: string): void {
    let activeHostId: string | null = null;

    socket.on("message", (data: RawData) => {
      let message: AgentToHubMessage;
      try {
        message = parseJsonMessage(AgentToHubMessageSchema, data);
      } catch (error) {
        this.#logger.warn({ err: error, claimedHostId }, "Rejected agent protocol frame");
        socket.close(1008, "Invalid agent frame");
        return;
      }

      if (message.type === "hello") {
        if (message.hostId !== claimedHostId) {
          socket.close(1008, "Host identity mismatch");
          return;
        }
        activeHostId = message.hostId;
        const existing = this.#hosts.get(message.hostId);
        if (existing?.socket && existing.socket !== socket) {
          existing.socket.close(1012, "A newer agent connection replaced this one");
        }
        const now = new Date().toISOString();
        this.#hosts.set(message.hostId, {
          id: message.hostId,
          name: message.hostName,
          platform: message.platform,
          agentVersion: message.agentVersion,
          socket,
          sessions: existing?.sessions ?? new Map(),
          connectedAt: now,
          lastSeenAt: now,
        });
        this.#logger.info({ hostId: message.hostId, hostName: message.hostName }, "Agent registered");
        return;
      }

      if (!activeHostId) {
        socket.close(1008, "Agent must send hello first");
        return;
      }
      const host = this.#hosts.get(activeHostId);
      if (!host || host.socket !== socket) {
        socket.close(1008, "Stale agent connection");
        return;
      }
      host.lastSeenAt = new Date().toISOString();
      this.#handleAgentMessage(host, message);
    });

    socket.on("close", () => {
      if (!activeHostId) return;
      const host = this.#hosts.get(activeHostId);
      if (host?.socket === socket) {
        host.socket = null;
        host.lastSeenAt = new Date().toISOString();
        this.#closeHostTunnels(activeHostId);
        this.#logger.info({ hostId: activeHostId }, "Agent disconnected");
      }
    });
  }

  public listHosts(): HostView[] {
    return [...this.#hosts.values()]
      .map((host) => ({
        id: host.id,
        name: host.name,
        platform: host.platform,
        agentVersion: host.agentVersion,
        online: host.socket?.readyState === WebSocket.OPEN,
        connectedAt: host.connectedAt,
        lastSeenAt: host.lastSeenAt,
        sessions: [...host.sessions.values()].sort((left, right) =>
          right.startedAt.localeCompare(left.startedAt)
        ),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public hasOnlineSession(hostId: string, sessionId: string): boolean {
    const host = this.#hosts.get(hostId);
    return Boolean(
      host?.socket?.readyState === WebSocket.OPEN && host.sessions.has(sessionId),
    );
  }

  public attachBrowser(socket: WebSocket, grant: AttachmentGrant): void {
    const host = this.#hosts.get(grant.hostId);
    if (!host?.socket || host.socket.readyState !== WebSocket.OPEN || !host.sessions.has(grant.sessionId)) {
      socket.close(1013, "Host or session is offline");
      return;
    }
    const tunnel: TunnelRecord = {
      id: randomUUID(),
      hostId: grant.hostId,
      sessionId: grant.sessionId,
      clientId: grant.identityId,
      socket,
    };
    this.#tunnels.set(tunnel.id, tunnel);
    this.#sendAgent(host.socket, {
      type: "attach",
      tunnelId: tunnel.id,
      sessionId: tunnel.sessionId,
      clientId: tunnel.clientId,
    });

    socket.on("message", (data: RawData) => {
      try {
        const message = parseJsonMessage(ClientTerminalMessageSchema, data);
        const currentHost = this.#hosts.get(tunnel.hostId);
        if (!currentHost?.socket || currentHost.socket.readyState !== WebSocket.OPEN) {
          socket.close(1013, "Host is offline");
          return;
        }
        this.#sendAgent(currentHost.socket, {
          type: "terminal-message",
          tunnelId: tunnel.id,
          message,
        });
      } catch (error) {
        this.#logger.debug({ err: error, tunnelId: tunnel.id }, "Rejected browser terminal frame");
        socket.close(1008, "Invalid terminal frame");
      }
    });
    const detach = () => this.#detachTunnel(tunnel.id);
    socket.on("close", detach);
    socket.on("error", detach);
  }

  public close(): void {
    for (const tunnel of this.#tunnels.values()) {
      tunnel.socket.close(1001, "Hub shutting down");
    }
    this.#tunnels.clear();
    for (const host of this.#hosts.values()) {
      host.socket?.close(1001, "Hub shutting down");
      host.socket = null;
    }
  }

  #handleAgentMessage(
    host: HostRecord,
    message: Exclude<AgentToHubMessage, { type: "hello" }>,
  ): void {
    switch (message.type) {
      case "session-list": {
        host.sessions.clear();
        for (const session of message.sessions) {
          if (session.hostId === host.id) host.sessions.set(session.id, session);
        }
        return;
      }
      case "session-upsert": {
        if (message.session.hostId === host.id) {
          host.sessions.set(message.session.id, message.session);
        }
        return;
      }
      case "terminal-message": {
        const tunnel = this.#tunnels.get(message.tunnelId);
        if (!tunnel || tunnel.hostId !== host.id) return;
        if (tunnel.socket.readyState !== WebSocket.OPEN) {
          this.#detachTunnel(tunnel.id);
          return;
        }
        if (tunnel.socket.bufferedAmount > 4 * 1024 * 1024) {
          tunnel.socket.close(1013, "Viewer fell behind; reconnect to resynchronize");
          this.#detachTunnel(tunnel.id);
          return;
        }
        tunnel.socket.send(encodeMessage(message.message));
        return;
      }
      case "heartbeat":
        return;
    }
  }

  #detachTunnel(tunnelId: string): void {
    const tunnel = this.#tunnels.get(tunnelId);
    if (!tunnel) return;
    this.#tunnels.delete(tunnelId);
    const host = this.#hosts.get(tunnel.hostId);
    if (host?.socket?.readyState === WebSocket.OPEN) {
      this.#sendAgent(host.socket, { type: "detach", tunnelId });
    }
  }

  #closeHostTunnels(hostId: string): void {
    for (const tunnel of [...this.#tunnels.values()]) {
      if (tunnel.hostId === hostId) {
        tunnel.socket.close(1013, "Host is offline");
        this.#tunnels.delete(tunnel.id);
      }
    }
  }

  #sendAgent(socket: WebSocket, message: HubToAgentMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 4 * 1024 * 1024) {
      socket.close(1013, "Agent fell behind");
      return;
    }
    socket.send(encodeMessage(message));
  }
}
