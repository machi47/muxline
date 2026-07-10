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
import { HubCatalog, type PersistedHost } from "./catalog.js";

interface HostConnection {
  id: string;
  socket: WebSocket;
  connectedAt: string;
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

/**
 * Adds short-lived connection/tunnel state to the durable HubCatalog. A fresh
 * agent session-list is additive; it must never erase a saved record synced by
 * an earlier connection.
 */
export class HubRegistry {
  readonly #logger: pino.Logger;
  readonly #catalog: HubCatalog;
  readonly #connections = new Map<string, HostConnection>();
  readonly #tunnels = new Map<string, TunnelRecord>();

  public constructor(logger: pino.Logger, catalog: HubCatalog) {
    this.#logger = logger;
    this.#catalog = catalog;
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
        const previous = this.#connections.get(message.hostId);
        if (previous && previous.socket !== socket) {
          previous.socket.close(1012, "A newer agent connection replaced this one");
        }
        this.#connections.set(message.hostId, {
          id: message.hostId,
          socket,
          connectedAt: new Date().toISOString(),
        });
        this.#catalog.upsertHost({
          id: message.hostId,
          name: message.hostName,
          platform: message.platform,
          agentVersion: message.agentVersion,
        });
        this.#logger.info({ hostId: message.hostId, hostName: message.hostName }, "Agent registered");
        return;
      }

      if (!activeHostId) {
        socket.close(1008, "Agent must send hello first");
        return;
      }
      const connection = this.#connections.get(activeHostId);
      if (!connection || connection.socket !== socket) {
        socket.close(1008, "Stale agent connection");
        return;
      }
      this.#catalog.touchHost(activeHostId);
      this.#handleAgentMessage(activeHostId, message);
    });

    socket.on("close", () => {
      if (!activeHostId) return;
      const connection = this.#connections.get(activeHostId);
      if (connection?.socket === socket) {
        this.#connections.delete(activeHostId);
        this.#catalog.touchHost(activeHostId);
        this.#closeHostTunnels(activeHostId);
        this.#logger.info({ hostId: activeHostId }, "Agent disconnected");
      }
    });
  }

  public listHosts(): HostView[] {
    return this.#catalog.hosts().map((host) => this.#hostView(host));
  }

  public hasOnlineSession(hostId: string, sessionId: string): boolean {
    const connection = this.#connections.get(hostId);
    const session = this.#catalog.session(hostId, sessionId);
    return Boolean(
      connection?.socket.readyState === WebSocket.OPEN
      && session?.state === "live",
    );
  }

  public async snapshot(hostId: string, sessionId: string): Promise<{ session: SessionSummary; data: string } | null> {
    const session = this.#catalog.session(hostId, sessionId);
    if (!session) return null;
    const data = await this.#catalog.snapshot(hostId, sessionId);
    return data === null ? null : { session, data };
  }

  public attachBrowser(socket: WebSocket, grant: AttachmentGrant): void {
    const connection = this.#connections.get(grant.hostId);
    if (!connection || connection.socket.readyState !== WebSocket.OPEN || !this.hasOnlineSession(grant.hostId, grant.sessionId)) {
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
    this.#sendAgent(connection.socket, {
      type: "attach",
      tunnelId: tunnel.id,
      sessionId: tunnel.sessionId,
      clientId: tunnel.clientId,
    });

    socket.on("message", (data: RawData) => {
      try {
        const message = parseJsonMessage(ClientTerminalMessageSchema, data);
        const current = this.#connections.get(tunnel.hostId);
        if (!current || current.socket.readyState !== WebSocket.OPEN) {
          socket.close(1013, "Host is offline");
          return;
        }
        this.#sendAgent(current.socket, { type: "terminal-message", tunnelId: tunnel.id, message });
      } catch (error) {
        this.#logger.debug({ err: error, tunnelId: tunnel.id }, "Rejected browser terminal frame");
        socket.close(1008, "Invalid terminal frame");
      }
    });
    const detach = () => this.#detachTunnel(tunnel.id);
    socket.on("close", detach);
    socket.on("error", detach);
  }

  public async close(): Promise<void> {
    for (const tunnel of this.#tunnels.values()) {
      tunnel.socket.close(1001, "Hub shutting down");
    }
    this.#tunnels.clear();
    for (const connection of this.#connections.values()) {
      connection.socket.close(1001, "Hub shutting down");
    }
    this.#connections.clear();
    await this.#catalog.close();
  }

  #handleAgentMessage(
    hostId: string,
    message: Exclude<AgentToHubMessage, { type: "hello" }>,
  ): void {
    switch (message.type) {
      case "session-list":
        for (const session of message.sessions) {
          if (session.hostId === hostId) this.#catalog.upsertSession(session);
        }
        return;
      case "session-upsert":
        if (message.session.hostId === hostId) this.#catalog.upsertSession(message.session);
        return;
      case "session-snapshot":
        if (message.hostId === hostId) {
          void this.#catalog.saveSnapshot(message).catch((error: unknown) => {
            this.#logger.warn({ err: error, hostId, sessionId: message.sessionId }, "Could not persist session snapshot");
          });
        }
        return;
      case "terminal-message": {
        const tunnel = this.#tunnels.get(message.tunnelId);
        if (!tunnel || tunnel.hostId !== hostId) return;
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

  #hostView(host: PersistedHost): HostView {
    const connection = this.#connections.get(host.id);
    return {
      id: host.id,
      name: host.name,
      platform: host.platform,
      agentVersion: host.agentVersion,
      online: connection?.socket.readyState === WebSocket.OPEN,
      connectedAt: connection?.connectedAt ?? null,
      lastSeenAt: host.lastSeenAt,
      sessions: [...host.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    };
  }

  #detachTunnel(tunnelId: string): void {
    const tunnel = this.#tunnels.get(tunnelId);
    if (!tunnel) return;
    this.#tunnels.delete(tunnelId);
    const connection = this.#connections.get(tunnel.hostId);
    if (connection?.socket.readyState === WebSocket.OPEN) {
      this.#sendAgent(connection.socket, { type: "detach", tunnelId });
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
