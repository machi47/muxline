import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import websocket from "@fastify/websocket";
import {
  ClientTerminalMessageSchema,
  NativeSessionRefSchema,
  encodeMessage,
  parseJsonMessage,
  type ServerTerminalMessage,
} from "@muxline/protocol";
import Fastify from "fastify";
import * as nodePty from "node-pty";
import { WebSocket } from "ws";
import { z } from "zod";
import { buildLaunchSpec } from "./launch-adapter.js";
import { ManagedSession, type ManagedSessionChange } from "./session.js";
import { RunnerStore, RunnerManifestSchema, withRunnerSummary, type RunnerManifest } from "./runner-store.js";
import { XtermTerminalMirror } from "./terminal-mirror.js";

/**
 * A detached runner owns exactly one PTY and its screen mirror. The agent is a
 * restartable supervisor/client; it never needs to inherit this PTY handle.
 */
export async function runSessionRunner(manifestPath: string): Promise<void> {
  const manifest = RunnerManifestSchema.parse(await readManifest(manifestPath));
  if (!manifest.launch) throw new Error("Saved runner manifest cannot be started");
  const store = new RunnerStore(runnerDataDirectory(manifestPath));
  await store.initialize();
  const launch = buildLaunchSpec(manifest.launch.command, manifest.launch.args, manifest.launch.env);
  const pty = nodePty.spawn(launch.command, launch.args, {
    name: manifest.launch.term,
    cols: manifest.launch.cols,
    rows: manifest.launch.rows,
    cwd: manifest.launch.cwd,
    env: launch.env,
  });
  let current = manifest;
  let saveQueue: Promise<void> = Promise.resolve();
  let snapshotTimer: NodeJS.Timeout | null = null;
  let closing = false;
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => { finish = resolve; });

  const save = (next: RunnerManifest): void => {
    current = next;
    saveQueue = saveQueue.catch(() => undefined).then(() => store.save(current));
  };
  const session = new ManagedSession({
    summary: manifest.summary,
    pty,
    mirror: new XtermTerminalMirror(manifest.summary.cols, manifest.summary.rows),
    onChanged: (changed, change) => {
      save(withRunnerSummary(current, changed.summary()));
      if (change.captureSnapshot) scheduleSnapshot(changed, change);
      if (changed.summary().state !== "live") {
        setTimeout(() => void shutdown(false), 2_500).unref();
      }
    },
  });

  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(websocket, { options: { maxPayload: 2 * 1024 * 1024 } });
  app.get("/health", async (request, reply) => {
    if (!authorized(request.headers.authorization, current.token)) return reply.code(403).send();
    return { ok: true, id: current.id };
  });
  app.get("/v1/session", async (request, reply) => {
    if (!authorized(request.headers.authorization, current.token)) return reply.code(403).send();
    return { session: session.summary() };
  });
  app.get("/v1/session/snapshot", async (request, reply) => {
    if (!authorized(request.headers.authorization, current.token)) return reply.code(403).send();
    const data = await store.snapshot(current.id);
    return data === null ? reply.code(404).send({ error: "No runner screen" }) : { data };
  });
  app.post("/v1/interrupt", async (request, reply) => {
    if (!authorized(request.headers.authorization, current.token)) return reply.code(403).send();
    session.markInterrupted();
    void shutdown(false);
    return reply.code(204).send();
  });
  app.post("/v1/session/native", async (request, reply) => {
    if (!authorized(request.headers.authorization, current.token)) return reply.code(403).send();
    const input = z.object({
      nativeSession: NativeSessionRefSchema,
      rebound: z.boolean().optional(),
    }).parse(request.body);
    session.setNativeSession(input.nativeSession, input.rebound ?? false);
    return reply.code(204).send();
  });
  app.get<{ Querystring: { token?: string; clientId?: string; source?: string } }>(
    "/v1/terminal",
    { websocket: true },
    (socket, request) => {
      const clientId = request.query.clientId;
      const source = request.query.source === "remote" ? "remote" : "local";
      if (!clientId || !secureEqual(request.query.token ?? "", current.token)) {
        socket.close(1008, "Unauthorized");
        return;
      }
      const send = (message: ServerTerminalMessage) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > 4 * 1024 * 1024) {
          socket.close(1013, "Client is too slow");
          return;
        }
        socket.send(encodeMessage(message));
      };
      void session.attach(clientId, source, send).catch(() => socket.close(1011, "Attach failed"));
      socket.on("message", (data) => {
        try {
          session.handleClientMessage(clientId, parseJsonMessage(ClientTerminalMessageSchema, data));
        } catch {
          socket.close(1008, "Invalid terminal frame");
        }
      });
      socket.on("close", () => session.detach(clientId));
      socket.on("error", () => session.detach(clientId));
    },
  );

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Runner did not receive a loopback port");
  current = {
    ...current,
    pid: process.pid,
    port: address.port,
    status: "running",
    summary: session.summary(),
    updatedAt: new Date().toISOString(),
  };
  save(current);
  scheduleSnapshot(session, { immediate: true, durable: true, captureSnapshot: true, kind: "created" });

  const stop = () => { void shutdown(true); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await finished;

  function scheduleSnapshot(target: ManagedSession, change: ManagedSessionChange): void {
    if (!change.captureSnapshot || closing) return;
    if (snapshotTimer) {
      if (!change.immediate) return;
      clearTimeout(snapshotTimer);
    }
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      void captureSnapshot(target);
    }, change.immediate ? 0 : 750);
    snapshotTimer.unref();
  }

  async function captureSnapshot(target: ManagedSession): Promise<void> {
    try {
      const data = await target.snapshot();
      const bytes = await store.saveSnapshot(current.id, data);
      target.setSnapshot({
        available: true,
        capturedAt: new Date().toISOString(),
        bytes,
        sequence: target.summary().sequence,
      });
    } catch {
      // Runner ownership must not be disrupted by durable-screen I/O.
    }
  }

  async function shutdown(interrupt: boolean): Promise<void> {
    if (closing) return;
    closing = true;
    if (snapshotTimer) clearTimeout(snapshotTimer);
    if (interrupt) session.markInterrupted();
    await captureSnapshot(session);
    save(withRunnerSummary(current, session.summary()));
    await saveQueue;
    session.dispose();
    await app.close();
    finish();
  }
}

async function readManifest(manifestPath: string): Promise<unknown> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
}

function runnerDataDirectory(manifestPath: string): string {
  return path.dirname(path.dirname(manifestPath));
}

function authorized(value: string | undefined, token: string): boolean {
  return secureEqual(value?.startsWith("Bearer ") ? value.slice(7) : "", token);
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
