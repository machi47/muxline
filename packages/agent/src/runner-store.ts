import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SessionSummarySchema, type CreateSessionRequest, type SessionSummary } from "@muxline/protocol";

const RunnerLaunchSchema = z.object({
  command: z.string().min(1).max(16_384),
  args: z.array(z.string().max(1_048_576)).max(2048),
  cwd: z.string().min(1).max(16_384),
  env: z.record(z.string(), z.string()),
  term: z.string().min(1).max(200),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(1000),
});

export type RunnerLaunch = z.infer<typeof RunnerLaunchSchema>;

export const RunnerManifestSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  runtimeId: z.string().uuid(),
  token: z.string().min(24),
  pid: z.number().int().positive().nullable(),
  port: z.number().int().min(1024).max(65_535).nullable(),
  status: z.enum(["starting", "running", "saved", "interrupted"]),
  summary: SessionSummarySchema,
  launch: RunnerLaunchSchema.optional(),
  updatedAt: z.string().datetime(),
});
export type RunnerManifest = z.infer<typeof RunnerManifestSchema>;

export class RunnerStore {
  readonly #directory: string;

  public constructor(dataDir: string) {
    this.#directory = path.join(dataDir, "runners");
  }

  public async initialize(): Promise<void> {
    await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
  }

  public path(id: string): string {
    return path.join(this.#directory, `${id}.json`);
  }

  public snapshotPath(id: string): string {
    return path.join(this.#directory, `${id}.ansi`);
  }

  public async save(manifest: RunnerManifest): Promise<void> {
    await this.initialize();
    const parsed = RunnerManifestSchema.parse(manifest);
    await atomicWrite(this.path(parsed.id), `${JSON.stringify(parsed, null, 2)}\n`);
  }

  public async get(id: string): Promise<RunnerManifest | null> {
    return this.read(this.path(id));
  }

  public async read(manifestPath: string): Promise<RunnerManifest | null> {
    try {
      return RunnerManifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown);
    } catch (error) {
      if (isMissingFile(error)) return null;
      return null;
    }
  }

  public async list(): Promise<RunnerManifest[]> {
    await this.initialize();
    const entries = await fs.readdir(this.#directory, { withFileTypes: true });
    const manifests = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => this.read(path.join(this.#directory, entry.name))));
    return manifests.filter((manifest): manifest is RunnerManifest => manifest !== null);
  }

  public async saveSnapshot(id: string, data: string): Promise<number> {
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > 8 * 1024 * 1024) throw new Error("Runner snapshot exceeds 8 MiB");
    await atomicWrite(this.snapshotPath(id), data);
    return bytes;
  }

  public async snapshot(id: string): Promise<string | null> {
    try {
      return await fs.readFile(this.snapshotPath(id), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }
}

export function runnerLaunchFromRequest(
  request: CreateSessionRequest,
  environment: Record<string, string>,
  args: readonly string[],
  cwd: string,
): RunnerLaunch {
  return {
    command: request.command,
    args: [...args],
    cwd,
    env: environment,
    term: request.term,
    cols: request.cols,
    rows: request.rows,
  };
}

export function withRunnerSummary(manifest: RunnerManifest, summary: SessionSummary): RunnerManifest {
  if (summary.state === "live") {
    return {
      ...manifest,
      summary,
      status: "running",
      updatedAt: new Date().toISOString(),
    };
  }
  const { launch: _launch, ...withoutLaunch } = manifest;
  return {
    ...withoutLaunch,
    summary,
    status: summary.state,
    updatedAt: new Date().toISOString(),
  };
}

async function atomicWrite(target: string, data: string): Promise<void> {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
