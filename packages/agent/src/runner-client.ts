import {
  ClientTerminalMessageSchema,
  ServerTerminalMessageSchema,
  encodeMessage,
  parseJsonMessage,
  type ClientTerminalMessage,
  type NativeSessionRef,
  type ServerTerminalMessage,
  type SessionSummary,
} from "@muxline/protocol";
import WebSocket from "ws";
import type { RunnerManifest } from "./runner-store.js";

export interface LiveSessionHandle {
  readonly id: string;
  summary(): SessionSummary;
  snapshot(): Promise<string>;
  attach(
    clientId: string,
    source: "local" | "remote",
    send: (message: ServerTerminalMessage) => void,
  ): Promise<void>;
  detach(clientId: string): void;
  handleClientMessage(clientId: string, message: ClientTerminalMessage): void;
  setNativeSession(nativeSession: NativeSessionRef, rebound?: boolean): void | Promise<void>;
  dispose(): void;
}

export interface RunnerSessionCallbacks {
  onSummary: (summary: SessionSummary) => void;
  onSnapshot: (summary: SessionSummary, data: string) => void;
  onUnavailable: (summary: SessionSummary) => void;
}

/** A local-only proxy from the restartable agent supervisor to one detached runner. */
export class RunnerSession implements LiveSessionHandle {
  readonly id: string;
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #callbacks: RunnerSessionCallbacks;
  readonly #attachments = new Map<string, WebSocket>();
  #summary: SessionSummary;
  #pollTimer: NodeJS.Timeout | null = null;
  #disposed = false;
  #failedPolls = 0;
  #snapshotKey = "";

  private constructor(manifest: RunnerManifest, callbacks: RunnerSessionCallbacks) {
    if (!manifest.port) throw new Error("Runner has not opened its loopback port");
    this.id = manifest.id;
    this.#baseUrl = `http://127.0.0.1:${manifest.port}`;
    this.#token = manifest.token;
    this.#callbacks = callbacks;
    this.#summary = manifest.summary;
    this.#snapshotKey = snapshotKey(manifest.summary);
  }

  public static async connect(manifest: RunnerManifest, callbacks: RunnerSessionCallbacks): Promise<RunnerSession> {
    const session = new RunnerSession(manifest, callbacks);
    await session.#refresh();
    session.#startPolling();
    return session;
  }

  public summary(): SessionSummary {
    return this.#summary;
  }

  public async snapshot(): Promise<string> {
    const response = await this.#request("/v1/session/snapshot");
    const body = await response.json() as { data?: string; error?: string };
    if (!response.ok || body.data === undefined) throw new Error(body.error ?? "Runner screen is unavailable");
    return body.data;
  }

  public async attach(
    clientId: string,
    source: "local" | "remote",
    send: (message: ServerTerminalMessage) => void,
  ): Promise<void> {
    if (this.#disposed || this.#summary.state !== "live") throw new Error("This session is no longer live");
    if (this.#attachments.has(clientId)) throw new Error(`Client ${clientId} is already attached`);
    const url = new URL("/v1/terminal", this.#baseUrl);
    url.protocol = "ws:";
    url.searchParams.set("token", this.#token);
    url.searchParams.set("clientId", clientId);
    url.searchParams.set("source", source);
    const socket = new WebSocket(url, { maxPayload: 2 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      socket.on("open", () => {
        this.#attachments.set(clientId, socket);
        settle();
      });
      socket.on("message", (data) => {
        try {
          const message = parseJsonMessage(ServerTerminalMessageSchema, data);
          if (message.type === "snapshot" || message.type === "session") {
            this.#acceptSummary(message.session);
          }
          send(message);
        } catch {
          socket.close(1008, "Invalid runner frame");
        }
      });
      socket.on("error", (error) => settle(error));
      socket.on("close", () => {
        this.#attachments.delete(clientId);
        if (!settled) settle(new Error("Runner terminal connection closed before attach"));
      });
    });
  }

  public detach(clientId: string): void {
    const socket = this.#attachments.get(clientId);
    this.#attachments.delete(clientId);
    socket?.close(1000, "Detached from supervisor");
  }

  public handleClientMessage(clientId: string, message: ClientTerminalMessage): void {
    const socket = this.#attachments.get(clientId);
    if (socket?.readyState === WebSocket.OPEN) socket.send(encodeMessage(message));
  }

  public async setNativeSession(nativeSession: NativeSessionRef, rebound = false): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/v1/session/native`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ nativeSession, rebound }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error("Runner rejected native-session update");
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
    for (const socket of this.#attachments.values()) socket.close(1000, "Supervisor stopped");
    this.#attachments.clear();
  }

  #startPolling(): void {
    this.#pollTimer = setInterval(() => void this.#refresh(), 750);
    this.#pollTimer.unref();
  }

  async #refresh(): Promise<void> {
    if (this.#disposed) return;
    try {
      const response = await this.#request("/v1/session");
      const body = await response.json() as { session?: SessionSummary; error?: string };
      if (!response.ok || !body.session) throw new Error(body.error ?? "Runner summary is unavailable");
      this.#failedPolls = 0;
      this.#acceptSummary(body.session);
      const key = snapshotKey(body.session);
      if (body.session.snapshot.available && key !== this.#snapshotKey) {
        this.#snapshotKey = key;
        try {
          this.#callbacks.onSnapshot(body.session, await this.snapshot());
        } catch {
          // The next poll will retry when the runner has finished serializing.
          this.#snapshotKey = "";
        }
      }
    } catch {
      this.#failedPolls += 1;
      if (this.#failedPolls >= 3) {
        this.dispose();
        this.#callbacks.onUnavailable(this.#summary);
      }
    }
  }

  #acceptSummary(summary: SessionSummary): void {
    if (summary.revision < this.#summary.revision) return;
    this.#summary = summary;
    this.#callbacks.onSummary(summary);
  }

  #request(pathname: string): Promise<Response> {
    return fetch(`${this.#baseUrl}${pathname}`, {
      headers: { authorization: `Bearer ${this.#token}` },
      signal: AbortSignal.timeout(2_000),
    });
  }
}

export function parseRunnerClientMessage(value: unknown): ClientTerminalMessage {
  return ClientTerminalMessageSchema.parse(value);
}

function snapshotKey(session: SessionSummary): string {
  return `${session.snapshot.sequence}:${session.snapshot.capturedAt ?? ""}:${session.snapshot.bytes}`;
}
