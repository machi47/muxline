import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const AgentConfigFileSchema = z.object({
  version: z.literal(1),
  hostId: z.string().uuid(),
  hostName: z.string().min(1).max(200),
  localPort: z.number().int().min(1024).max(65_535),
  localToken: z.string().min(32),
  hubUrl: z.string().url().optional(),
  hubToken: z.string().min(16).optional(),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]),
});

export type AgentConfig = z.infer<typeof AgentConfigFileSchema> & {
  dataDir: string;
};

export async function loadOrCreateAgentConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AgentConfig> {
  const dataDir = environment.MUXLINE_HOME
    ? path.resolve(environment.MUXLINE_HOME)
    : path.join(os.homedir(), ".muxline");
  const configPath = path.join(dataDir, "agent.json");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });

  let fileConfig: z.infer<typeof AgentConfigFileSchema>;
  try {
    const content = await fs.readFile(configPath, "utf8");
    fileConfig = AgentConfigFileSchema.parse(JSON.parse(content) as unknown);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new Error(`Unable to load ${configPath}`, { cause: error });
    }
    fileConfig = {
      version: 1,
      hostId: randomUUID(),
      hostName: os.hostname(),
      localPort: 7337,
      localToken: randomBytes(32).toString("base64url"),
      logLevel: "info",
    };
    const temporaryPath = `${configPath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(fileConfig, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporaryPath, configPath);
    await fs.chmod(configPath, 0o600).catch(() => undefined);
  }

  const overrides = {
    ...fileConfig,
    ...(environment.MUXLINE_HOST_NAME ? { hostName: environment.MUXLINE_HOST_NAME } : {}),
    ...(environment.MUXLINE_LOCAL_PORT
      ? { localPort: Number.parseInt(environment.MUXLINE_LOCAL_PORT, 10) }
      : {}),
    ...(environment.MUXLINE_HUB_URL ? { hubUrl: environment.MUXLINE_HUB_URL } : {}),
    ...(environment.MUXLINE_HUB_TOKEN ? { hubToken: environment.MUXLINE_HUB_TOKEN } : {}),
    ...(environment.MUXLINE_LOG_LEVEL ? { logLevel: environment.MUXLINE_LOG_LEVEL } : {}),
  };

  return { ...AgentConfigFileSchema.parse(overrides), dataDir };
}

export async function saveAgentHubConfig(
  config: AgentConfig,
  hubUrl: string,
  hubToken: string,
): Promise<AgentConfig> {
  const updated = AgentConfigFileSchema.parse({
    version: config.version,
    hostId: config.hostId,
    hostName: config.hostName,
    localPort: config.localPort,
    localToken: config.localToken,
    hubUrl,
    hubToken,
    logLevel: config.logLevel,
  });
  const configPath = path.join(config.dataDir, "agent.json");
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await fs.rename(temporaryPath, configPath);
  await fs.chmod(configPath, 0o600).catch(() => undefined);
  return { ...updated, dataDir: config.dataDir };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
