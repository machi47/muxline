import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CreateSessionRequest, SessionSummary } from "@muxline/protocol";
import * as nodePty from "node-pty";
import type { IPty } from "node-pty";
import type { AgentConfig } from "./config.js";
import { buildLaunchSpec } from "./launch-adapter.js";
import { ManagedSession } from "./session.js";
import { XtermTerminalMirror, type TerminalMirror } from "./terminal-mirror.js";

export interface PtyFactory {
  spawn(
    command: string,
    args: string[],
    options: nodePty.IPtyForkOptions | nodePty.IWindowsPtyForkOptions,
  ): IPty;
}

export interface SessionManagerDependencies {
  ptyFactory?: PtyFactory;
  mirrorFactory?: (cols: number, rows: number) => TerminalMirror;
}

type SessionListener = (summary: SessionSummary) => void;

export class SessionManager {
  readonly #config: AgentConfig;
  readonly #ptyFactory: PtyFactory;
  readonly #mirrorFactory: (cols: number, rows: number) => TerminalMirror;
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #listeners = new Set<SessionListener>();
  readonly #pendingUpdates = new Map<string, NodeJS.Timeout>();

  public constructor(config: AgentConfig, dependencies: SessionManagerDependencies = {}) {
    this.#config = config;
    this.#ptyFactory = dependencies.ptyFactory ?? nodePty;
    this.#mirrorFactory = dependencies.mirrorFactory
      ?? ((cols, rows) => new XtermTerminalMirror(cols, rows));
  }

  public create(request: CreateSessionRequest): ManagedSession {
    const id = randomUUID();
    const cwdLabel = path.basename(request.cwd) || request.cwd;
    const launch = buildLaunchSpec(
      request.command,
      request.args,
      {
        ...request.env,
        TERM: request.term,
        MUXLINE_SESSION_ID: id,
      },
    );
    const pty = this.#ptyFactory.spawn(launch.command, launch.args, {
      name: request.term,
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env: launch.env,
    });
    const mirror = this.#mirrorFactory(request.cols, request.rows);
    let session: ManagedSession;
    session = new ManagedSession({
      id,
      hostId: this.#config.hostId,
      hostName: this.#config.hostName,
      profile: request.profile,
      displayName: request.displayName ?? `${request.profile} · ${cwdLabel}`,
      cwdLabel,
      cols: request.cols,
      rows: request.rows,
      pty,
      mirror,
      onChanged: (immediate) => this.#scheduleUpdate(session, immediate),
    });
    this.#sessions.set(id, session);
    this.#emit(session.summary());
    return session;
  }

  public get(id: string): ManagedSession | undefined {
    return this.#sessions.get(id);
  }

  public list(): SessionSummary[] {
    return [...this.#sessions.values()]
      .map((session) => session.summary())
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  public onUpsert(listener: SessionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public remove(id: string): boolean {
    const session = this.#sessions.get(id);
    if (!session || session.summary().state === "running") {
      return false;
    }
    session.dispose();
    this.#sessions.delete(id);
    const timer = this.#pendingUpdates.get(id);
    if (timer) {
      clearTimeout(timer);
      this.#pendingUpdates.delete(id);
    }
    return true;
  }

  public dispose(): void {
    for (const timer of this.#pendingUpdates.values()) {
      clearTimeout(timer);
    }
    this.#pendingUpdates.clear();
    for (const session of this.#sessions.values()) {
      session.dispose();
    }
    this.#sessions.clear();
    this.#listeners.clear();
  }

  #scheduleUpdate(session: ManagedSession, immediate: boolean): void {
    const existing = this.#pendingUpdates.get(session.id);
    if (immediate) {
      if (existing) {
        clearTimeout(existing);
        this.#pendingUpdates.delete(session.id);
      }
      this.#emit(session.summary());
      return;
    }
    if (existing) {
      return;
    }
    const timer = setTimeout(() => {
      this.#pendingUpdates.delete(session.id);
      this.#emit(session.summary());
    }, 250);
    timer.unref();
    this.#pendingUpdates.set(session.id, timer);
  }

  #emit(summary: SessionSummary): void {
    for (const listener of this.#listeners) {
      listener(summary);
    }
  }
}
