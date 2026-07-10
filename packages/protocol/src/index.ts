import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

export const SessionStateSchema = z.enum(["running", "exited", "failed"]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const ControllerSchema = z.object({
  clientId: z.string().min(1).max(200),
  source: z.enum(["local", "remote"]),
  acquiredAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type Controller = z.infer<typeof ControllerSchema>;

export const SessionSummarySchema = z.object({
  id: z.string().uuid(),
  hostId: z.string().uuid(),
  hostName: z.string().min(1).max(200),
  profile: z.string().min(1).max(100),
  displayName: z.string().min(1).max(240),
  cwdLabel: z.string().max(240),
  state: SessionStateSchema,
  startedAt: z.string().datetime(),
  lastOutputAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(1000),
  sequence: z.number().int().nonnegative(),
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
