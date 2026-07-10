import type {
  ClientTerminalMessage,
  Controller,
  ServerTerminalMessage,
  SessionSummary,
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

export interface ManagedSessionOptions {
  id: string;
  hostId: string;
  hostName: string;
  profile: string;
  displayName: string;
  cwdLabel: string;
  cols: number;
  rows: number;
  pty: IPty;
  mirror: TerminalMirror;
  onChanged: (immediate: boolean) => void;
}

export class ManagedSession {
  readonly id: string;
  readonly #hostId: string;
  readonly #hostName: string;
  readonly #profile: string;
  readonly #displayName: string;
  readonly #cwdLabel: string;
  readonly #pty: IPty;
  readonly #mirror: TerminalMirror;
  readonly #lease = new ControlLease();
  readonly #subscribers = new Map<string, Subscriber>();
  readonly #onChanged: (immediate: boolean) => void;
  readonly #startedAt = new Date();
  #lastOutputAt = this.#startedAt;
  #endedAt: Date | null = null;
  #state: "running" | "exited" | "failed" = "running";
  #exitCode: number | null = null;
  #signal: number | null = null;
  #cols: number;
  #rows: number;
  #sequence = 0;
  #disposed = false;

  public constructor(options: ManagedSessionOptions) {
    this.id = options.id;
    this.#hostId = options.hostId;
    this.#hostName = options.hostName;
    this.#profile = options.profile;
    this.#displayName = options.displayName;
    this.#cwdLabel = options.cwdLabel;
    this.#cols = options.cols;
    this.#rows = options.rows;
    this.#pty = options.pty;
    this.#mirror = options.mirror;
    this.#onChanged = options.onChanged;

    this.#pty.onData((data) => this.#handleOutput(data));
    this.#pty.onExit(({ exitCode, signal }) => this.#handleExit(exitCode, signal ?? 0));
  }

  public summary(): SessionSummary {
    return {
      id: this.id,
      hostId: this.#hostId,
      hostName: this.#hostName,
      profile: this.#profile,
      displayName: this.#displayName,
      cwdLabel: this.#cwdLabel,
      state: this.#state,
      startedAt: this.#startedAt.toISOString(),
      lastOutputAt: this.#lastOutputAt.toISOString(),
      endedAt: this.#endedAt?.toISOString() ?? null,
      exitCode: this.#exitCode,
      signal: this.#signal,
      cols: this.#cols,
      rows: this.#rows,
      sequence: this.#sequence,
      viewers: this.#subscribers.size,
      controller: this.#lease.current(),
    };
  }

  public async attach(
    clientId: string,
    source: "local" | "remote",
    send: (message: ServerTerminalMessage) => void,
  ): Promise<void> {
    if (this.#disposed) {
      throw new Error("Session is no longer available");
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
    const snapshotSequence = this.#sequence;
    const snapshotSummary = { ...this.summary(), sequence: snapshotSequence };
    this.#onChanged(true);

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
      if (this.#state !== "running" && this.#exitCode !== null) {
        this.#send(subscriber, {
          type: "exit",
          exitCode: this.#exitCode,
          signal: this.#signal,
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
      this.#onChanged(true);
    }
  }

  public handleClientMessage(clientId: string, message: ClientTerminalMessage): void {
    const subscriber = this.#subscribers.get(clientId);
    if (!subscriber) {
      return;
    }

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
        if (this.#state === "running") {
          this.#pty.write(message.data);
        }
        return;
      }
      case "resize": {
        if (!this.#lease.touch(clientId)) {
          return;
        }
        if (message.cols === this.#cols && message.rows === this.#rows) {
          return;
        }
        this.#cols = message.cols;
        this.#rows = message.rows;
        this.#pty.resize(message.cols, message.rows);
        this.#mirror.resize(message.cols, message.rows);
        this.#onChanged(true);
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
        this.#onChanged(true);
        return;
      }
      case "release-control": {
        if (this.#lease.release(clientId)) {
          this.#broadcastControl();
          this.#onChanged(true);
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
    if (this.#state === "running") {
      this.#pty.kill();
    }
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#subscribers.clear();
    this.#mirror.dispose();
  }

  #handleOutput(data: string): void {
    if (this.#disposed) {
      return;
    }
    this.#sequence += 1;
    this.#lastOutputAt = new Date();
    const output = { sequence: this.#sequence, data };
    this.#mirror.write(data);

    for (const subscriber of this.#subscribers.values()) {
      if (!subscriber.ready) {
        subscriber.pending.push(output);
        continue;
      }
      this.#send(subscriber, { type: "output", ...output });
    }
    this.#onChanged(false);
  }

  #handleExit(exitCode: number, signal: number): void {
    if (this.#state !== "running") {
      return;
    }
    this.#state = "exited";
    this.#exitCode = exitCode;
    this.#signal = signal === 0 ? null : signal;
    this.#endedAt = new Date();
    for (const subscriber of this.#subscribers.values()) {
      this.#send(subscriber, {
        type: "exit",
        exitCode,
        signal: this.#signal,
      });
    }
    this.#onChanged(true);
  }

  #broadcastControl(): void {
    for (const subscriber of this.#subscribers.values()) {
      this.#sendControlState(subscriber);
    }
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
