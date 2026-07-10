#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClientTerminalMessageSchema,
  ServerTerminalMessageSchema,
  encodeMessage,
  parseJsonMessage,
  type CreateSessionRequest,
  type ServerTerminalMessage,
  type SessionSummary,
} from "@muxline/protocol";
import pino from "pino";
import WebSocket from "ws";
import { createAgentServer } from "./agent-server.js";
import { loadOrCreateAgentConfig, saveAgentHubConfig, saveAgentProfile } from "./config.js";
import { HubBridge } from "./hub-bridge.js";
import { buildLaunchSpec } from "./launch-adapter.js";
import { LocalAgentApi } from "./local-api.js";
import { SessionManager } from "./session-manager.js";
import { runSessionRunner } from "./runner-process.js";
import { installShims } from "./shims.js";

interface RunArguments {
  profile: string;
  displayName?: string;
  command: string;
  args: string[];
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "agent":
      return runAgent();
    case "run":
      return runManaged(parseRunArguments(args));
    case "attach":
      return attachExisting(args);
    case "list":
      return listSessions();
    case "shim":
      return createShims(args);
    case "configure-hub":
      return configureHub(args);
    case "profile":
      return configureProfile(args);
    case "doctor":
      return doctor();
    case "claude-hook":
      return runClaudeHook();
    case "runner":
      return runRunner(args);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      return 0;
    default:
      throw new Error(`Unknown command: ${command}\nRun muxline help for usage.`);
  }
}

async function runAgent(): Promise<number> {
  const config = await loadOrCreateAgentConfig();
  const logger = pino({
    level: config.logLevel,
    redact: {
      paths: ["hubToken", "localToken", "req.headers.authorization", "url"],
      censor: "[redacted]",
    },
  });
  const sessions = new SessionManager(config);
  await sessions.initialize();
  const server = await createAgentServer(config, sessions, logger);
  const hub = new HubBridge(config, sessions, logger);

  await server.start();
  hub.start();
  await waitForShutdownSignal();
  hub.stop();
  await server.close();
  await sessions.shutdown();
  logger.info("Muxline agent stopped");
  return 0;
}

async function runManaged(options: RunArguments): Promise<number> {
  const environment = stringEnvironment(process.env);
  if (environment.MUXLINE_WRAPPED === "1" || !process.stdin.isTTY || !process.stdout.isTTY) {
    return runDirect(options.command, options.args, environment);
  }

  const config = await loadOrCreateAgentConfig();
  const api = new LocalAgentApi(config);
  await ensureAgent(api);
  const request: CreateSessionRequest = {
    profile: options.profile,
    ...(options.displayName ? { displayName: options.displayName } : {}),
    command: options.command,
    args: options.args,
    cwd: process.cwd(),
    env: environment,
    cols: terminalColumns(),
    rows: terminalRows(),
    term: environment.TERM ?? "xterm-256color",
  };
  const session = await api.createSession(request);
  return attachTerminal(api, session, true);
}

async function attachExisting(args: string[]): Promise<number> {
  const sessionId = args[0];
  if (!sessionId) {
    throw new Error("Usage: muxline attach <session-id>");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Attaching requires an interactive terminal");
  }
  const config = await loadOrCreateAgentConfig();
  const api = new LocalAgentApi(config);
  await ensureAgent(api);
  const session = (await api.listSessions()).find((candidate) => candidate.id === sessionId);
  if (!session) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  return attachTerminal(api, session, true);
}

async function attachTerminal(
  api: LocalAgentApi,
  session: SessionSummary,
  claimControl: boolean,
): Promise<number> {
  const clientId = `local-${randomUUID()}`;
  const socket = new WebSocket(api.terminalUrl(session.id, clientId), {
    maxPayload: 2 * 1024 * 1024,
  });
  const wasRaw = process.stdin.isRaw;
  let finished = false;
  let sawExit = false;

  return new Promise<number>((resolve, reject) => {
    const cleanup = () => {
      if (finished) return;
      finished = true;
      process.stdout.off("resize", onResize);
      process.stdin.off("data", onInput);
      if (process.stdin.isTTY && !wasRaw) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };
    const finish = (code: number) => {
      cleanup();
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "Terminal detached");
      }
      resolve(code);
    };
    const send = (message: ReturnType<typeof ClientTerminalMessageSchema.parse>) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(encodeMessage(message));
      }
    };
    const onResize = () => {
      send({ type: "resize", cols: terminalColumns(), rows: terminalRows() });
    };
    const onInput = (chunk: Buffer | string) => {
      send({ type: "input", data: typeof chunk === "string" ? chunk : chunk.toString("utf8") });
    };

    socket.on("open", () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.on("data", onInput);
      process.stdout.on("resize", onResize);
      if (claimControl) {
        send({ type: "claim-control", force: false });
      }
      onResize();
    });

    socket.on("message", (data) => {
      let message: ServerTerminalMessage;
      try {
        message = parseJsonMessage(ServerTerminalMessageSchema, data);
      } catch (error) {
        cleanup();
        reject(new Error("Agent sent an invalid terminal frame", { cause: error }));
        return;
      }
      switch (message.type) {
        case "snapshot":
          process.stdout.write("\u001bc");
          process.stdout.write(message.data);
          return;
        case "output":
          process.stdout.write(message.data);
          return;
        case "exit":
          sawExit = true;
          finish(message.exitCode);
          return;
        case "error":
          if (message.code !== "CONTROL_REQUIRED") {
            process.stderr.write(`\r\nMuxline: ${message.message}\r\n`);
          }
          return;
        case "control":
        case "session":
        case "pong":
          return;
      }
    });
    socket.on("error", (error) => {
      cleanup();
      reject(error);
    });
    socket.on("close", (code, reason) => {
      if (finished) return;
      cleanup();
      if (sawExit || code === 1000) {
        resolve(0);
      } else {
        reject(new Error(`Terminal connection closed (${code}): ${reason.toString()}`));
      }
    });
  });
}

async function listSessions(): Promise<number> {
  const config = await loadOrCreateAgentConfig();
  const api = new LocalAgentApi(config);
  if (!(await api.health())) {
    process.stdout.write("Muxline agent is not running.\n");
    return 1;
  }
  const sessions = await api.listSessions();
  if (sessions.length === 0) {
    process.stdout.write("No sessions.\n");
    return 0;
  }
  const rows = sessions.map((session) => ({
    id: session.id,
    state: session.state,
    profile: session.profile.label,
    cwd: session.workspace.path,
    started: session.startedAt,
    control: session.controller?.source ?? "-",
  }));
  console.table(rows);
  return 0;
}

async function createShims(names: string[]): Promise<number> {
  const result = await installShims(names);
  for (const shim of result.shims) {
    process.stdout.write(`${shim.name} -> ${shim.target}\n`);
  }
  process.stdout.write(`\nAdd this directory before your normal PATH entries once:\n${result.binDir}\n`);
  if (process.platform === "win32") {
    process.stdout.write("Then open a new Windows Terminal tab.\n");
  } else {
    process.stdout.write(`For zsh:  export PATH=${quoteForDisplay(result.binDir)}:$PATH\n`);
  }
  return 0;
}

async function configureHub(args: string[]): Promise<number> {
  const [hubUrl, hubToken] = args;
  if (!hubUrl || !hubToken || args.length !== 2) {
    throw new Error("Usage: muxline configure-hub <https-url> <agent-token>");
  }
  const parsedUrl = new URL(hubUrl);
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("Hub URL must use https (or http for loopback development)");
  }
  if (hubToken.length < 16) {
    throw new Error("Agent token must contain at least 16 characters");
  }
  const config = await loadOrCreateAgentConfig();
  await saveAgentHubConfig(config, parsedUrl.toString(), hubToken);
  process.stdout.write(`Saved hub settings to ${path.join(config.dataDir, "agent.json")}\n`);
  return 0;
}

async function configureProfile(args: string[]): Promise<number> {
  if (args[0] === "list") {
    const config = await loadOrCreateAgentConfig();
    process.stdout.write(`${JSON.stringify(config.profiles, null, 2)}\n`);
    return 0;
  }
  if (args[0] !== "set" || !args[1]) {
    throw new Error("Usage: muxline profile set <alias> --harness <claude-code|codex|generic> [--label text] [--provider name]");
  }
  const id = args[1];
  let harness: "claude-code" | "codex" | "generic" | undefined;
  let label: string | undefined;
  let provider: string | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`${flag ?? "Option"} requires a value`);
    if (flag === "--harness") harness = parseHarness(value);
    else if (flag === "--label") label = value;
    else if (flag === "--provider") provider = value;
    else throw new Error(`Unknown profile option: ${flag}`);
    index += 1;
  }
  if (!harness) throw new Error("--harness is required");
  const config = await loadOrCreateAgentConfig();
  await saveAgentProfile(config, id, {
    harness,
    ...(label ? { label } : {}),
    ...(provider ? { provider } : {}),
  });
  process.stdout.write(`Saved profile ${id} as ${harness}.\n`);
  return 0;
}

async function doctor(): Promise<number> {
  const config = await loadOrCreateAgentConfig();
  const api = new LocalAgentApi(config);
  const status = {
    agentRunning: await api.health(),
    hostId: config.hostId,
    hostName: config.hostName,
    localEndpoint: `127.0.0.1:${config.localPort}`,
    hubConfigured: Boolean(config.hubUrl && config.hubToken),
    hubUrl: config.hubUrl ?? null,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
  };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  return status.agentRunning ? 0 : 1;
}

/** Invoked only by Muxline's per-launch Claude plugin. It must stay silent. */
async function runClaudeHook(): Promise<number> {
  const sessionId = process.env.MUXLINE_SESSION_ID;
  const token = process.env.MUXLINE_HOOK_TOKEN;
  if (!sessionId || !token) return 0;
  try {
    const input = await readStdin(1_048_576);
    const payload = JSON.parse(input) as unknown;
    if (!payload || typeof payload !== "object") return 0;
    const config = await loadOrCreateAgentConfig();
    await fetch(`http://127.0.0.1:${config.localPort}/v1/claude-hook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-muxline-hook-token": token,
      },
      body: JSON.stringify({ muxlineSessionId: sessionId, payload }),
      signal: AbortSignal.timeout(1_500),
    });
  } catch {
    // Hooks must not make Claude's own session noisy or fail to start/end.
  }
  return 0;
}

async function runRunner(args: string[]): Promise<number> {
  const manifestPath = args[0];
  if (!manifestPath || args.length !== 1) throw new Error("Usage: muxline runner <manifest-path>");
  await runSessionRunner(manifestPath);
  return 0;
}

async function ensureAgent(api: LocalAgentApi): Promise<void> {
  if (await api.health()) return;
  const entry = fileURLToPath(import.meta.url);
  const nodeArgs = entry.endsWith(".ts")
    ? ["--import", "tsx", entry, "agent"]
    : [entry, "agent"];
  const child = spawn(process.execPath, nodeArgs, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await delay(100);
    if (await api.health()) return;
  }
  throw new Error("Muxline agent did not start. Run `muxline agent` to see its error output.");
}

async function runDirect(
  command: string,
  args: string[],
  environment: Record<string, string>,
): Promise<number> {
  const launch = buildLaunchSpec(command, args, environment);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: process.cwd(),
      env: launch.env,
      stdio: "inherit",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) {
        resolve(code);
      } else {
        process.stderr.write(`Muxline child ended from signal ${signal ?? "unknown"}.\n`);
        resolve(1);
      }
    });
  });
}

function parseRunArguments(args: string[]): RunArguments {
  let profile = "terminal";
  let displayName: string | undefined;
  let index = 0;
  while (index < args.length && args[index] !== "--") {
    const argument = args[index];
    if (argument === "--profile") {
      profile = requiredValue(args, ++index, "--profile");
    } else if (argument === "--display-name") {
      displayName = requiredValue(args, ++index, "--display-name");
    } else {
      throw new Error(`Unknown muxline run option: ${argument}`);
    }
    index += 1;
  }
  if (args[index] !== "--") {
    throw new Error("Usage: muxline run [--profile name] -- <command> [args...]");
  }
  const command = args[index + 1];
  if (!command) {
    throw new Error("Missing command after --");
  }
  return {
    profile,
    ...(displayName ? { displayName } : {}),
    command,
    args: args.slice(index + 2),
  };
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function terminalColumns(): number {
  return Math.max(2, process.stdout.columns || 80);
}

function terminalRows(): number {
  return Math.max(1, process.stdout.rows || 24);
}

function parseHarness(value: string): "claude-code" | "codex" | "generic" {
  if (value === "claude-code" || value === "codex" || value === "generic") return value;
  throw new Error("--harness must be claude-code, codex, or generic");
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readStdin(limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.length;
    if (total > limit) throw new Error("Hook input is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function quoteForDisplay(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function printHelp(): void {
  process.stdout.write(`Muxline — persistent terminal sessions without tmux commands

Usage:
  muxline shim claude claude-glm codex
  muxline configure-hub <https-url> <agent-token>
  muxline profile set <alias> --harness <claude-code|codex|generic> [--provider name]
  muxline profile list
  muxline run --profile <name> -- <command> [arguments...]
  muxline attach <session-id>
  muxline list
  muxline doctor
  muxline agent

Configured shims preserve every Claude/Codex flag. Non-interactive and piped
invocations bypass the broker so scripts keep their normal I/O behavior.
`);
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Muxline: ${message}\n`);
    process.exitCode = 1;
  },
);
