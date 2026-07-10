import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CreateSessionRequest, NativeSessionRef, SessionSummary } from "@muxline/protocol";
import * as nodePty from "node-pty";
import type { IPty } from "node-pty";
import type { AgentConfig } from "./config.js";
import { ensureClaudeHookPlugin } from "./claude-plugin.js";
import { AgentLedger } from "./ledger.js";
import { buildLaunchSpec } from "./launch-adapter.js";
import { linkedNativeRef, nativeAdapterFor, unresolvedNativeRef } from "./native-adapters.js";
import { resolveLaunchProfile } from "./profiles.js";
import { RunnerSession, type LiveSessionHandle } from "./runner-client.js";
import { RunnerStore, runnerLaunchFromRequest, type RunnerManifest } from "./runner-store.js";
import { ManagedSession, type ManagedSessionChange } from "./session.js";
import { XtermTerminalMirror, type TerminalMirror } from "./terminal-mirror.js";
import { describeWorkspace } from "./workspace.js";

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
  ledger?: AgentLedger;
  /** In-process mode exists for unit tests only; production defaults to runners. */
  useRunners?: boolean;
}

export interface ClaudeHookPayload {
  session_id: string;
  transcript_path?: string | undefined;
  cwd?: string | undefined;
  hook_event_name?: string | undefined;
}

type SessionListener = (summary: SessionSummary) => void;
type SnapshotListener = (session: SessionSummary, data: string) => void;
type NativeAwareSession = LiveSessionHandle;

/**
 * Owns the short-lived PTY bindings and hydrates the durable logical records
 * that remain after a terminal, agent, or host disappears.
 */
export class SessionManager {
  readonly #config: AgentConfig;
  readonly #ptyFactory: PtyFactory;
  readonly #mirrorFactory: (cols: number, rows: number) => TerminalMirror;
  readonly #ledger: AgentLedger;
  readonly #runnerStore: RunnerStore;
  readonly #useRunners: boolean;
  readonly #live = new Map<string, NativeAwareSession>();
  readonly #records = new Map<string, SessionSummary>();
  readonly #listeners = new Set<SessionListener>();
  readonly #snapshotListeners = new Set<SnapshotListener>();
  readonly #pendingUpdates = new Map<string, NodeJS.Timeout>();
  readonly #pendingSnapshots = new Map<string, NodeJS.Timeout>();
  readonly #nativePolls = new Map<string, NodeJS.Timeout>();
  readonly #hookTokens = new Map<string, string>();
  readonly #writes = new Map<string, Promise<void>>();
  #initialized = false;
  #stopping = false;

  public constructor(config: AgentConfig, dependencies: SessionManagerDependencies = {}) {
    this.#config = config;
    this.#ptyFactory = dependencies.ptyFactory ?? nodePty;
    this.#mirrorFactory = dependencies.mirrorFactory
      ?? ((cols, rows) => new XtermTerminalMirror(cols, rows));
    this.#ledger = dependencies.ledger ?? new AgentLedger(config.dataDir);
    this.#runnerStore = new RunnerStore(config.dataDir);
    this.#useRunners = dependencies.useRunners ?? true;
  }

  public async initialize(): Promise<void> {
    if (this.#initialized) return;
    await this.#ledger.initialize();
    await this.#runnerStore.initialize();
    const manifests = this.#useRunners ? await this.#runnerStore.list() : [];
    const activeIds = new Set(
      manifests
        .filter((manifest) => (manifest.status === "running" || manifest.status === "starting") && manifest.summary.state === "live")
        .map((manifest) => manifest.id),
    );
    await this.#ledger.markPreviouslyLiveInterrupted(activeIds);
    for (const record of await this.#ledger.list()) {
      this.#records.set(record.session.id, record.session);
    }
    for (const originalManifest of manifests) {
      const manifest = originalManifest.status === "starting"
        ? (await this.#waitForRunnerManifest(originalManifest.id, 3_000) ?? originalManifest)
        : originalManifest;
      const hookToken = manifest.launch?.env.MUXLINE_HOOK_TOKEN;
      if (hookToken) this.#hookTokens.set(manifest.id, hookToken);
      const existing = this.#records.get(manifest.id);
      if (!existing || manifest.summary.revision >= existing.revision) {
        this.#records.set(manifest.id, manifest.summary);
        this.#queuePersist(manifest.summary);
      }
      if (manifest.summary.snapshot.available) {
        void this.#syncRunnerSnapshot(manifest);
      }
      if (manifest.status !== "running" || !manifest.port) continue;
      try {
        const session = await RunnerSession.connect(manifest, this.#runnerCallbacks());
        this.#live.set(manifest.id, session);
        this.#records.set(manifest.id, session.summary());
      } catch {
        this.#markRunnerUnavailable(manifest.summary);
      }
    }
    this.#initialized = true;
  }

  public async create(request: CreateSessionRequest): Promise<LiveSessionHandle> {
    await this.initialize();
    const profile = resolveLaunchProfile(request.profile, request.command, this.#config.profiles);
    const workspace = await describeWorkspace(this.#config.hostId, request.cwd);
    const adapter = nativeAdapterFor(profile.harness);
    const launchTime = new Date();
    const nativeHint = adapter?.launchHint(request.args) ?? null;
    const ephemeral = adapter?.isEphemeral(request.args) ?? false;
    const rebound = nativeHint ? this.#findRebind(profile.harness, nativeHint) : undefined;
    const id = rebound?.id ?? randomUUID();
    const runtimeId = randomUUID();
    const now = launchTime.toISOString();
    const nativeSession: NativeSessionRef = ephemeral
      ? {
        harness: profile.harness,
        id: null,
        status: "missing",
        confidence: "none",
        title: "Ephemeral native session",
        sourcePath: null,
        updatedAt: now,
        resumeCommand: null,
      }
      : nativeHint && adapter
      ? {
        harness: adapter.harness,
        id: nativeHint,
        status: "linked",
        confidence: "exact",
        title: null,
        sourcePath: null,
        updatedAt: now,
        resumeCommand: adapter.resumeCommand(profile, nativeHint),
      }
      : unresolvedNativeRef(profile.harness);
    const summary: SessionSummary = {
      id,
      revision: (rebound?.revision ?? 0) + 1,
      hostId: this.#config.hostId,
      hostName: this.#config.hostName,
      profile,
      workspace,
      displayName: request.displayName ?? `${profile.label} · ${workspace.label}`,
      nativeSession,
      state: "live",
      runtimeId,
      startedAt: rebound?.startedAt ?? now,
      lastOutputAt: now,
      updatedAt: now,
      endedAt: null,
      reboundAt: rebound ? now : null,
      exitCode: null,
      signal: null,
      cols: request.cols,
      rows: request.rows,
      sequence: 0,
      snapshot: rebound?.snapshot ?? {
        available: false,
        capturedAt: null,
        bytes: 0,
        sequence: 0,
      },
      viewers: 0,
      controller: null,
    };
    const hookToken = profile.harness === "claude-code"
      ? randomBytes(24).toString("base64url")
      : null;
    const commandArgs = profile.harness === "claude-code"
      ? ["--plugin-dir", await ensureClaudeHookPlugin(this.#config), ...request.args]
      : request.args;
    const environment = {
      ...request.env,
      TERM: request.term,
      MUXLINE_SESSION_ID: id,
      MUXLINE_RUNTIME_ID: runtimeId,
      ...(hookToken ? { MUXLINE_HOOK_TOKEN: hookToken } : {}),
    };
    this.#records.set(id, summary);
    if (hookToken) this.#hookTokens.set(id, hookToken);
    this.#queuePersist(summary, rebound ? "rebound" : "created");
    let session: NativeAwareSession;
    try {
      session = this.#useRunners
        ? await this.#startRunner({
          version: 1,
          id,
          runtimeId,
          token: randomBytes(32).toString("base64url"),
          pid: null,
          port: null,
          status: "starting",
          summary,
          launch: runnerLaunchFromRequest(request, environment, commandArgs, workspace.path),
          updatedAt: now,
        })
        : this.#createInProcess(summary, request, workspace.path, environment, commandArgs);
    } catch (error) {
      this.#markRunnerUnavailable(summary);
      throw error;
    }
    this.#live.set(id, session);
    this.#records.set(id, session.summary());
    this.#emit(session.summary());
    if (!this.#useRunners && session instanceof ManagedSession) this.#scheduleSnapshot(session, true);
    if (!nativeHint && adapter && !ephemeral) {
      this.#scheduleNativeDiscovery(session, request, launchTime, adapter);
    }
    return session;
  }

  public get(id: string): NativeAwareSession | undefined {
    return this.#live.get(id);
  }

  public list(): SessionSummary[] {
    return [...this.#records.values()]
      .map((record) => this.#live.get(record.id)?.summary() ?? record)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async snapshot(id: string): Promise<string | null> {
    const live = this.#live.get(id);
    if (live) {
      try {
        return await live.snapshot();
      } catch {
        // A runner may have just finalized its own endpoint; its durable file is authoritative now.
      }
    }
    return (await this.#runnerStore.snapshot(id)) ?? this.#ledger.snapshot(id);
  }

  public async applyClaudeHook(sessionId: string, token: string, payload: ClaudeHookPayload): Promise<boolean> {
    const expected = this.#hookTokens.get(sessionId);
    const record = this.#records.get(sessionId);
    if (!expected || expected !== token || !record || record.profile.harness !== "claude-code") {
      return false;
    }
    const now = new Date().toISOString();
    const nativeSession: NativeSessionRef = {
      harness: "claude-code",
      id: payload.session_id,
      status: "linked",
      confidence: "exact",
      title: null,
      sourcePath: payload.transcript_path ?? record.nativeSession.sourcePath,
      updatedAt: now,
      resumeCommand: `${record.profile.invocation} --resume ${payload.session_id}`,
    };
    const live = this.#live.get(sessionId);
    if (live) {
      if (live.summary().nativeSession.id !== payload.session_id) {
        await live.setNativeSession(nativeSession);
      }
      return true;
    }
    const updated: SessionSummary = {
      ...record,
      revision: record.revision + 1,
      nativeSession,
      updatedAt: now,
    };
    this.#records.set(sessionId, updated);
    this.#queuePersist(updated, "native-linked");
    this.#emit(updated);
    return true;
  }

  public onUpsert(listener: SessionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public onSnapshot(listener: SnapshotListener): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  public async remove(id: string): Promise<boolean> {
    if (this.#live.has(id) || !this.#records.has(id)) return false;
    this.#records.delete(id);
    await this.#ledger.delete(id);
    return true;
  }

  public async shutdown(): Promise<void> {
    this.#stopping = true;
    for (const timer of this.#pendingUpdates.values()) clearTimeout(timer);
    for (const timer of this.#pendingSnapshots.values()) clearTimeout(timer);
    for (const timer of this.#nativePolls.values()) clearTimeout(timer);
    this.#pendingUpdates.clear();
    this.#pendingSnapshots.clear();
    this.#nativePolls.clear();
    this.#hookTokens.clear();
    for (const session of this.#live.values()) {
      if (session instanceof ManagedSession) session.markInterrupted();
      session.dispose();
    }
    this.#live.clear();
    await Promise.all(this.#writes.values());
    this.#writes.clear();
    this.#listeners.clear();
    this.#snapshotListeners.clear();
  }

  #createInProcess(
    summary: SessionSummary,
    request: CreateSessionRequest,
    cwd: string,
    environment: Record<string, string>,
    args: readonly string[],
  ): ManagedSession {
    const launch = buildLaunchSpec(request.command, args, environment);
    const pty = this.#ptyFactory.spawn(launch.command, launch.args, {
      name: request.term,
      cols: request.cols,
      rows: request.rows,
      cwd,
      env: launch.env,
    });
    return new ManagedSession({
      summary,
      pty,
      mirror: this.#mirrorFactory(request.cols, request.rows),
      onChanged: (current, change) => this.#handleSessionChange(current, change),
    });
  }

  async #startRunner(manifest: RunnerManifest): Promise<RunnerSession> {
    await this.#runnerStore.save(manifest);
    const manifestPath = this.#runnerStore.path(manifest.id);
    const compiledEntry = fileURLToPath(new URL("./cli.js", import.meta.url));
    const sourceEntry = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const entry = await fileExists(compiledEntry) ? compiledEntry : sourceEntry;
    const args = entry.endsWith(".ts")
      ? ["--import", "tsx", entry, "runner", manifestPath]
      : [entry, "runner", manifestPath];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const ready = await this.#runnerStore.get(manifest.id);
      if (ready?.status === "running" && ready.port) {
        try {
          return await RunnerSession.connect(ready, this.#runnerCallbacks());
        } catch {
          // The runner may have written its port before Fastify was accepting connections.
        }
      } else if (ready && ready.status !== "starting") {
        break;
      }
      await delay(75);
    }
    throw new Error("Muxline runner did not become ready. Run `muxline agent` to inspect its host logs.");
  }

  async #waitForRunnerManifest(id: string, timeoutMilliseconds: number): Promise<RunnerManifest | null> {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
      const current = await this.#runnerStore.get(id);
      if (current?.status === "running" && current.port) return current;
      if (current && current.status !== "starting") return current;
      await delay(75);
    }
    return this.#runnerStore.get(id);
  }

  #runnerCallbacks() {
    return {
      onSummary: (summary: SessionSummary) => this.#handleRunnerSummary(summary),
      onSnapshot: (summary: SessionSummary, data: string) => this.#handleRunnerSnapshot(summary, data),
      onUnavailable: (summary: SessionSummary) => this.#markRunnerUnavailable(summary),
    };
  }

  #handleRunnerSummary(summary: SessionSummary): void {
    const previous = this.#records.get(summary.id);
    if (previous && previous.revision > summary.revision) return;
    this.#records.set(summary.id, summary);
    const event = previous?.state === "live" && summary.state === "saved" ? "saved" : undefined;
    this.#queuePersist(summary, event);
    this.#scheduleUpdate(summary, true);
  }

  #handleRunnerSnapshot(summary: SessionSummary, data: string): void {
    this.#records.set(summary.id, summary);
    void this.#ledger.saveSnapshot(summary.id, data).then(
      () => {
        this.#queuePersist(summary);
        for (const listener of this.#snapshotListeners) listener(summary, data);
      },
      () => undefined,
    );
  }

  async #syncRunnerSnapshot(manifest: RunnerManifest): Promise<void> {
    try {
      const data = await this.#runnerStore.snapshot(manifest.id);
      if (data !== null) await this.#ledger.saveSnapshot(manifest.id, data);
    } catch {
      // The descriptor still gives the user a truthful saved card without a screen.
    }
  }

  #markRunnerUnavailable(summary: SessionSummary): void {
    if (summary.state !== "live") return;
    const current = this.#records.get(summary.id) ?? summary;
    if (current.state !== "live") return;
    const now = new Date().toISOString();
    const interrupted: SessionSummary = {
      ...current,
      revision: current.revision + 1,
      state: "interrupted",
      runtimeId: null,
      endedAt: now,
      updatedAt: now,
      viewers: 0,
      controller: null,
    };
    this.#live.delete(summary.id);
    this.#records.set(summary.id, interrupted);
    this.#queuePersist(interrupted, "interrupted");
    this.#emit(interrupted);
  }

  #findRebind(harness: SessionSummary["profile"]["harness"], nativeId: string): SessionSummary | undefined {
    return [...this.#records.values()]
      .filter((record) =>
        record.profile.harness === harness
        && record.nativeSession.id === nativeId
        && record.state !== "live"
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  #handleSessionChange(session: ManagedSession, change: ManagedSessionChange): void {
    const summary = session.summary();
    this.#records.set(summary.id, summary);
    if (change.durable) this.#queuePersist(summary, eventFor(change));
    if (change.captureSnapshot) this.#scheduleSnapshot(session, change.immediate);
    this.#scheduleUpdate(summary, change.immediate);
    if (summary.state !== "live") {
      this.#live.delete(summary.id);
      const timer = this.#nativePolls.get(summary.id);
      if (timer) clearTimeout(timer);
      this.#nativePolls.delete(summary.id);
      const token = this.#hookTokens.get(summary.id);
      if (token) {
        const expiration = setTimeout(() => this.#hookTokens.delete(summary.id), 5 * 60_000);
        expiration.unref();
      }
    }
  }

  #scheduleUpdate(summary: SessionSummary, immediate: boolean): void {
    const existing = this.#pendingUpdates.get(summary.id);
    if (immediate) {
      if (existing) {
        clearTimeout(existing);
        this.#pendingUpdates.delete(summary.id);
      }
      this.#emit(summary);
      return;
    }
    if (existing) return;
    const timer = setTimeout(() => {
      this.#pendingUpdates.delete(summary.id);
      const current = this.#live.get(summary.id)?.summary() ?? this.#records.get(summary.id);
      if (current) this.#emit(current);
    }, 250);
    timer.unref();
    this.#pendingUpdates.set(summary.id, timer);
  }

  #scheduleSnapshot(session: ManagedSession, immediate: boolean): void {
    const existing = this.#pendingSnapshots.get(session.id);
    if (existing) {
      if (!immediate) return;
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.#pendingSnapshots.delete(session.id);
      void this.#captureSnapshot(session);
    }, immediate ? 0 : 750);
    timer.unref();
    this.#pendingSnapshots.set(session.id, timer);
  }

  async #captureSnapshot(session: ManagedSession): Promise<void> {
    try {
      const data = await session.snapshot();
      const saved = await this.#ledger.saveSnapshot(session.id, data);
      const summary = session.summary();
      const capturedAt = new Date().toISOString();
      session.setSnapshot({
        available: true,
        capturedAt,
        bytes: saved.bytes,
        sequence: summary.sequence,
      });
      const updated = session.summary();
      for (const listener of this.#snapshotListeners) listener(updated, data);
    } catch {
      // A transient xterm/file failure must never block terminal output or control.
    }
  }

  #scheduleNativeDiscovery(
    session: NativeAwareSession,
    request: CreateSessionRequest,
    launchedAt: Date,
    adapter: NonNullable<ReturnType<typeof nativeAdapterFor>>,
  ): void {
    let attempts = 0;
    const poll = () => {
      if (this.#stopping || session.summary().state !== "live" || session.summary().nativeSession.id) {
        this.#nativePolls.delete(session.id);
        return;
      }
      void adapter.discover({
        profile: session.summary().profile,
        cwd: request.cwd,
        environment: request.env,
        launchedAt,
      }).then((candidates) => {
        if (candidates.length === 1) {
          const candidate = candidates[0];
          if (candidate) {
            void Promise.resolve(
              session.setNativeSession(linkedNativeRef(adapter, session.summary().profile, candidate)),
            ).catch(() => undefined);
          }
          this.#nativePolls.delete(session.id);
          return;
        }
        attempts += 1;
        if (attempts >= 80 || this.#stopping) {
          this.#nativePolls.delete(session.id);
          return;
        }
        const timer = setTimeout(poll, 1_500);
        timer.unref();
        this.#nativePolls.set(session.id, timer);
      }, () => {
        attempts += 1;
        if (attempts >= 80 || this.#stopping) {
          this.#nativePolls.delete(session.id);
          return;
        }
        const timer = setTimeout(poll, 1_500);
        timer.unref();
        this.#nativePolls.set(session.id, timer);
      });
    };
    const timer = setTimeout(poll, 500);
    timer.unref();
    this.#nativePolls.set(session.id, timer);
  }

  #queuePersist(summary: SessionSummary, event?: "created" | "native-linked" | "saved" | "interrupted" | "rebound"): void {
    const previous = this.#writes.get(summary.id) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        const latest = this.#live.get(summary.id)?.summary() ?? this.#records.get(summary.id) ?? summary;
        await this.#ledger.save(latest, event);
      });
    this.#writes.set(summary.id, write);
    void write.finally(() => {
      if (this.#writes.get(summary.id) === write) this.#writes.delete(summary.id);
    });
  }

  #emit(summary: SessionSummary): void {
    for (const listener of this.#listeners) listener(summary);
  }
}

function eventFor(change: ManagedSessionChange): "created" | "native-linked" | "saved" | "interrupted" | "rebound" | undefined {
  switch (change.kind) {
    case "created":
    case "native-linked":
    case "saved":
    case "interrupted":
    case "rebound":
      return change.kind;
    case "snapshot":
      return undefined;
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
