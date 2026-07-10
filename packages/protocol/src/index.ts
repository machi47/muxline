import { z } from "zod";

/**
 * Wire protocol revisions are deliberately explicit. A hub and agent must not
 * silently reinterpret durable session records from a newer build.
 */
export const PROTOCOL_VERSION = 2 as const;

export const HarnessKindSchema = z.enum(["claude-code", "codex", "generic"]);
export type HarnessKind = z.infer<typeof HarnessKindSchema>;

/**
 * This is the durable logical-record state, not a PTY exit state. Reachability
 * is derived by the hub from the host connection: a live record on a disconnected
 * host is shown as "unreachable", never rewritten as closed.
 */
export const SessionStateSchema = z.enum(["live", "saved", "interrupted"]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const NativeSessionStatusSchema = z.enum([
  "unresolved",
  "linked",
  "missing",
]);
export type NativeSessionStatus = z.infer<typeof NativeSessionStatusSchema>;

export const LaunchProfileSchema = z.object({
  /** Stable Muxline profile ID, usually the intercepted command name. */
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(160),
  harness: HarnessKindSchema,
  /** Provider/mode only labels a launch profile; it never changes the harness. */
  provider: z.string().min(1).max(160).nullable(),
  invocation: z.string().min(1).max(240),
});
export type LaunchProfile = z.infer<typeof LaunchProfileSchema>;

export const WorkspaceSchema = z.object({
  /** Stable per-host key derived from canonical path, never a globally portable path. */
  id: z.string().min(8).max(160),
  path: z.string().min(1).max(16_384),
  label: z.string().min(1).max(240),
  gitRoot: z.string().min(1).max(16_384).nullable(),
  repository: z.string().min(1).max(240).nullable(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const NativeSessionRefSchema = z.object({
  harness: HarnessKindSchema,
  /** Opaque, harness-owned session ID. Muxline never manufactures this value. */
  id: z.string().min(1).max(512).nullable(),
  status: NativeSessionStatusSchema,
  /** How sure the agent is that the native ID belongs to this logical record. */
  confidence: z.enum(["exact", "observed", "candidate", "none"]),
  title: z.string().min(1).max(500).nullable(),
  sourcePath: z.string().min(1).max(16_384).nullable(),
  updatedAt: z.string().datetime().nullable(),
  /** Deliberately short, redacted native re-entry affordance, if known. */
  resumeCommand: z.string().min(1).max(1_024).nullable(),
});
export type NativeSessionRef = z.infer<typeof NativeSessionRefSchema>;

export const SnapshotInfoSchema = z.object({
  available: z.boolean(),
  capturedAt: z.string().datetime().nullable(),
  bytes: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
});
export type SnapshotInfo = z.infer<typeof SnapshotInfoSchema>;

export const ControllerSchema = z.object({
  clientId: z.string().min(1).max(200),
  source: z.enum(["local", "remote"]),
  acquiredAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type Controller = z.infer<typeof ControllerSchema>;

/**
 * A logical session is the durable thing shown in the UI. `runtimeId` is only
 * present while a currently running broker PTY is bound to this record.
 */
export const SessionSummarySchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  hostId: z.string().uuid(),
  hostName: z.string().min(1).max(200),
  profile: LaunchProfileSchema,
  workspace: WorkspaceSchema,
  displayName: z.string().min(1).max(240),
  nativeSession: NativeSessionRefSchema,
  state: SessionStateSchema,
  runtimeId: z.string().uuid().nullable(),
  startedAt: z.string().datetime(),
  lastOutputAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  reboundAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(1000),
  sequence: z.number().int().nonnegative(),
  snapshot: SnapshotInfoSchema,
  viewers: z.number().int().nonnegative(),
  controller: ControllerSchema.nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const CreateSessionRequestSchema = z.object({
  profile: z.string().min(1).max(100),
  displayName: z.string().min(1).max(240).optional(),
  command: z.string().min(1).max(16_384),
  args: z.array(z.string().max(1_048_576)).max(2048),
  cwd: z.string().min(1).max(16_384),
  env: z.record(z.string(), z.string()).refine(
    (environment) => Object.keys(environment).length <= 4096,
    "Too many environment variables",
  ),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(1000),
  term: z.string().min(1).max(200),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const ClientTerminalMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(1_048_576) }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
  z.object({ type: z.literal("claim-control"), force: z.boolean().default(false) }),
  z.object({ type: z.literal("release-control") }),
  z.object({ type: z.literal("ping"), at: z.number().int() }),
]);
export type ClientTerminalMessage = z.infer<typeof ClientTerminalMessageSchema>;

export const ServerTerminalMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    session: SessionSummarySchema,
    sequence: z.number().int().nonnegative(),
    data: z.string(),
    hasControl: z.boolean(),
  }),
  z.object({
    type: z.literal("output"),
    sequence: z.number().int().nonnegative(),
    data: z.string(),
  }),
  z.object({ type: z.literal("session"), session: SessionSummarySchema }),
  z.object({
    type: z.literal("control"),
    controller: ControllerSchema.nullable(),
    hasControl: z.boolean(),
    reason: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("exit"),
    exitCode: z.number().int(),
    signal: z.number().int().nullable(),
  }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("pong"), at: z.number().int() }),
]);
export type ServerTerminalMessage = z.infer<typeof ServerTerminalMessageSchema>;

export const AgentToHubMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: z.literal(PROTOCOL_VERSION),
    hostId: z.string().uuid(),
    hostName: z.string().min(1).max(200),
    platform: z.string().min(1).max(100),
    agentVersion: z.string().min(1).max(100),
  }),
  z.object({ type: z.literal("session-list"), sessions: z.array(SessionSummarySchema) }),
  z.object({ type: z.literal("session-upsert"), session: SessionSummarySchema }),
  z.object({
    type: z.literal("session-snapshot"),
    hostId: z.string().uuid(),
    sessionId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    capturedAt: z.string().datetime(),
    sequence: z.number().int().nonnegative(),
    data: z.string().max(8 * 1024 * 1024),
  }),
  z.object({
    type: z.literal("terminal-message"),
    tunnelId: z.string().uuid(),
    message: ServerTerminalMessageSchema,
  }),
  z.object({ type: z.literal("heartbeat"), at: z.number().int() }),
]);
export type AgentToHubMessage = z.infer<typeof AgentToHubMessageSchema>;

export const HubToAgentMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attach"),
    tunnelId: z.string().uuid(),
    sessionId: z.string().uuid(),
    clientId: z.string().min(1).max(200),
  }),
  z.object({ type: z.literal("detach"), tunnelId: z.string().uuid() }),
  z.object({
    type: z.literal("terminal-message"),
    tunnelId: z.string().uuid(),
    message: ClientTerminalMessageSchema,
  }),
  z.object({ type: z.literal("heartbeat"), at: z.number().int() }),
]);
export type HubToAgentMessage = z.infer<typeof HubToAgentMessageSchema>;

export const AttachmentRequestSchema = z.object({
  hostId: z.string().uuid(),
  sessionId: z.string().uuid(),
});
export type AttachmentRequest = z.infer<typeof AttachmentRequestSchema>;

export function parseJsonMessage<T>(
  schema: z.ZodType<T>,
  value: string | Buffer | ArrayBuffer | Buffer[],
): T {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (Array.isArray(value)) {
    text = Buffer.concat(value).toString("utf8");
  } else if (value instanceof ArrayBuffer) {
    text = Buffer.from(value).toString("utf8");
  } else {
    text = value.toString("utf8");
  }

  return schema.parse(JSON.parse(text) as unknown);
}

export function encodeMessage(message: object): string {
  return JSON.stringify(message);
}
