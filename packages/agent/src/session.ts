import type {
  ClientTerminalMessage,
  Controller,
  NativeSessionRef,
  ServerTerminalMessage,
  SessionSummary,
  SnapshotInfo,
} from "@muxline/protocol";
import type { IPty } from "node-pty";
import { ControlLease } from "./control-lease.js";
import type { TerminalMirror } from "./terminal-mirror.js";

interface PendingOutput {
  sequence: number;
  data: string;
}

interface Subscriber {
  clientId: string;
  source: "local" | "remote";
  send: (message: ServerTerminalMessage) => void;
  ready: boolean;
  pending: PendingOutput[];
}

export interface ManagedSessionChange {
  immediate: boolean;
  durable: boolean;
  captureSnapshot: boolean;
  kind: "created" | "native-linked" | "saved" | "interrupted" | "rebound" | "snapshot";
}

export interface ManagedSessionOptions {
  summary: SessionSummary;
  pty: IPty;
  mirror: TerminalMirror;
  onChanged: (session: ManagedSession, change: ManagedSessionChange) => void;
}

/**
 * The live PTY binding. The durable identity is `summary.id`; this class never
 * pretends an exited PTY is a native Claude/Codex session.
 */
export class ManagedSession {
  readonly id: string;
  readonly #pty: IPty;
  readonly #mirror: TerminalMirror;
  readonly #lease = new ControlLease();
  readonly #subscribers = new Map<string, Subscriber>();
  readonly #onChanged: (session: ManagedSession, change: ManagedSessionChange) => void;
  #summary: SessionSummary;
  #disposed = false;

  public constructor(options: ManagedSessionOptions) {
    this.id = options.summary.id;
    this.#summary = options.summary;
    this.#pty = options.pty;
    this.#mirror = options.mirror;
    this.#onChanged = options.onChanged;

    this.#pty.onData((data) => this.#handleOutput(data));
    this.#pty.onExit(({ exitCode, signal }) => this.#handleExit(exitCode, signal ?? 0));
  }

  public summary(): SessionSummary {
    return {
      ...this.#summary,
      viewers: this.#subscribers.size,
      controller: this.#lease.current(),
    };
  }

  public snapshot(): Promise<string> {
    return this.#mirror.snapshot();
  }

  public setNativeSession(nativeSession: NativeSessionRef, rebound = false): void {
    this.#summary = {
      ...this.#summary,
      revision: this.#summary.revision + 1,
      nativeSession,
      ...(rebound ? { reboundAt: new Date().toISOString() } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.#onChanged(this, {
      immediate: true,
      durable: true,
      captureSnapshot: false,
      kind: rebound ? "rebound" : "native-linked",
    });
  }

  public setSnapshot(snapshot: SnapshotInfo): void {
    this.#summary = {
      ...this.#summary,
      revision: this.#summary.revision + 1,
      snapshot,
      updatedAt: new Date().toISOString(),
    };
    this.#onChanged(this, {
      immediate: true,
      durable: true,
      captureSnapshot: false,
      kind: "snapshot",
    });
  }

  public markInterrupted(): void {
    if (this.#summary.state !== "live") return;
    const now = new Date().toISOString();
    this.#summary = {
      ...this.#summary,
      revision: this.#summary.revision + 1,
      state: "interrupted",
      runtimeId: null,
      endedAt: now,
      updatedAt: now,
    };
    this.#onChanged(this, {
      immediate: true,
      durable: true,
      captureSnapshot: false,
      kind: "interrupted",
    });
  }

  public async attach(
    clientId: string,
    source: "local" | "remote",
    send: (message: ServerTerminalMessage) => void,
  ): Promise<void> {
    if (this.#disposed || this.#summary.state !== "live") {
      throw new Error("This session is no longer live");
    }
    if (this.#subscribers.has(clientId)) {
      throw new Error(`Client ${clientId} is already attached`);
    }

    const subscriber: Subscriber = {
      clientId,
      source,
      send,
      ready: false,
      pending: [],
    };
    this.#subscribers.set(clientId, subscriber);
    const snapshotSequence = this.#summary.sequence;
    const snapshotSummary = { ...this.summary(), sequence: snapshotSequence };
    this.#notifyTransient(true);

    try {
      const data = await this.#mirror.snapshot();
      this.#send(subscriber, {
        type: "snapshot",
        session: snapshotSummary,
        sequence: snapshotSequence,
        data,
        hasControl: this.#lease.isHolder(clientId),
      });
      for (const output of subscriber.pending) {
        this.#send(subscriber, { type: "output", ...output });
      }
      subscriber.pending.length = 0;
      subscriber.ready = true;
      this.#sendControlState(subscriber);
      if (this.#summary.state !== "live" && this.#summary.exitCode !== null) {
        this.#send(subscriber, {
          type: "exit",
          exitCode: this.#summary.exitCode,
          signal: this.#summary.signal,
        });
      }
    } catch (error) {
      this.detach(clientId);
      throw error;
    }
  }

  public detach(clientId: string): void {
    const existed = this.#subscribers.delete(clientId);
    const released = this.#lease.release(clientId);
    if (released) {
      this.#broadcastControl();
    }
    if (existed) {
      this.#notifyTransient(true);
    }
  }

  public handleClientMessage(clientId: string, message: ClientTerminalMessage): void {
    const subscriber = this.#subscribers.get(clientId);
    if (!subscriber) return;

    switch (message.type) {
      case "input": {
        if (!this.#lease.touch(clientId)) {
          this.#send(subscriber, {
            type: "error",
            code: "CONTROL_REQUIRED",
            message: "Take control before sending terminal input",
          });
          return;
        }
        if (this.#summary.state === "live") {
          this.#pty.write(message.data);
        }
        return;
      }
      case "resize": {
        if (!this.#lease.touch(clientId)) return;
        if (message.cols === this.#summary.cols && message.rows === this.#summary.rows) return;
        this.#pty.resize(message.cols, message.rows);
        this.#mirror.resize(message.cols, message.rows);
        this.#summary = {
          ...this.#summary,
          revision: this.#summary.revision + 1,
          cols: message.cols,
          rows: message.rows,
          updatedAt: new Date().toISOString(),
        };
        this.#onChanged(this, {
          immediate: true,
          durable: true,
          captureSnapshot: true,
          kind: "snapshot",
        });
        return;
      }
      case "claim-control": {
        const result = this.#lease.claim(clientId, subscriber.source, message.force);
        if (!result.granted) {
          this.#send(subscriber, {
            type: "control",
            controller: result.controller,
            hasControl: false,
            ...(result.reason ? { reason: result.reason } : {}),
          });
          return;
        }
        this.#broadcastControl();
        this.#notifyTransient(true);
        return;
      }
      case "release-control": {
        if (this.#lease.release(clientId)) {
          this.#broadcastControl();
          this.#notifyTransient(true);
        }
        return;
      }
      case "ping": {
        this.#lease.touch(clientId);
        this.#send(subscriber, { type: "pong", at: message.at });
        return;
      }
    }
  }

  public kill(): void {
    if (this.#summary.state === "live") this.#pty.kill();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#subscribers.clear();
    this.#mirror.dispose();
  }

  #handleOutput(data: string): void {
    if (this.#disposed) return;
    const now = new Date().toISOString();
    const sequence = this.#summary.sequence + 1;
    this.#summary = {
      ...this.#summary,
      revision: this.#summary.revision + 1,
      sequence,
      lastOutputAt: now,
      updatedAt: now,
    };
    const output = { sequence, data };
    this.#mirror.write(data);

    for (const subscriber of this.#subscribers.values()) {
      if (!subscriber.ready) {
        subscriber.pending.push(output);
        continue;
      }
      this.#send(subscriber, { type: "output", ...output });
    }
    this.#onChanged(this, {
      immediate: false,
      durable: true,
      captureSnapshot: true,
      kind: "snapshot",
    });
  }

  #handleExit(exitCode: number, signal: number): void {
    if (this.#summary.state !== "live") return;
    const now = new Date().toISOString();
    this.#summary = {
      ...this.#summary,
      revision: this.#summary.revision + 1,
      state: "saved",
      runtimeId: null,
      exitCode,
      signal: signal === 0 ? null : signal,
      endedAt: now,
      updatedAt: now,
    };
    for (const subscriber of this.#subscribers.values()) {
      this.#send(subscriber, { type: "exit", exitCode, signal: this.#summary.signal });
    }
    this.#onChanged(this, {
      immediate: true,
      durable: true,
      captureSnapshot: true,
      kind: "saved",
    });
  }

  #notifyTransient(immediate: boolean): void {
    this.#onChanged(this, {
      immediate,
      durable: false,
      captureSnapshot: false,
      kind: "snapshot",
    });
  }

  #broadcastControl(): void {
    for (const subscriber of this.#subscribers.values()) this.#sendControlState(subscriber);
  }

  #sendControlState(subscriber: Subscriber): void {
    const controller: Controller | null = this.#lease.current();
    this.#send(subscriber, {
      type: "control",
      controller,
      hasControl: controller?.clientId === subscriber.clientId,
    });
  }

  #send(subscriber: Subscriber, message: ServerTerminalMessage): void {
    try {
      subscriber.send(message);
    } catch {
      this.detach(subscriber.clientId);
    }
  }
}
