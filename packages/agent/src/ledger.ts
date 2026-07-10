import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SessionSummarySchema, type SessionSummary } from "@muxline/protocol";

const LedgerEventSchema = z.object({
  id: z.string().uuid(),
  at: z.string().datetime(),
  kind: z.enum(["created", "native-linked", "saved", "interrupted", "rebound", "snapshot"]),
  detail: z.string().max(1_000).optional(),
});

const StoredSessionSchema = z.object({
  version: z.literal(1),
  session: SessionSummarySchema,
  events: z.array(LedgerEventSchema).max(256),
});

export type LedgerEvent = z.infer<typeof LedgerEventSchema>;
export type StoredSession = z.infer<typeof StoredSessionSchema>;

/**
 * A tiny file-per-session ledger keeps process failures localized: a damaged
 * record cannot erase a different workspace/session. Snapshots are separate
 * ANSI/xterm serializations, never a transcript or a recreated native context.
 */
export class AgentLedger {
  readonly #root: string;
  readonly #recordsDir: string;
  readonly #snapshotsDir: string;

  public constructor(dataDir: string) {
    this.#root = path.join(dataDir, "ledger");
    this.#recordsDir = path.join(this.#root, "sessions");
    this.#snapshotsDir = path.join(this.#root, "snapshots");
  }

  public async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.#recordsDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.#snapshotsDir, { recursive: true, mode: 0o700 }),
    ]);
  }

  public async list(): Promise<StoredSession[]> {
    await this.initialize();
    const entries = await fs.readdir(this.#recordsDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => this.#readRecord(path.join(this.#recordsDir, entry.name))));
    return records
      .filter((record): record is StoredSession => record !== null)
      .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt));
  }

  public async get(id: string): Promise<StoredSession | null> {
    return this.#readRecord(this.#recordPath(id));
  }

  public async save(
    session: SessionSummary,
    kind?: LedgerEvent["kind"],
    detail?: string,
  ): Promise<StoredSession> {
    await this.initialize();
    const previous = await this.get(session.id);
    const event = kind ? {
      id: randomUUID(),
      at: new Date().toISOString(),
      kind,
      ...(detail ? { detail } : {}),
    } satisfies LedgerEvent : null;
    const record = StoredSessionSchema.parse({
      version: 1,
      session,
      events: event ? [...(previous?.events ?? []), event].slice(-256) : (previous?.events ?? []),
    });
    await atomicWrite(this.#recordPath(session.id), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  public async saveSnapshot(
    sessionId: string,
    data: string,
  ): Promise<{ bytes: number; path: string }> {
    await this.initialize();
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > 8 * 1024 * 1024) {
      throw new Error("Terminal snapshot exceeds the 8 MiB durable-record limit");
    }
    const snapshotPath = this.#snapshotPath(sessionId);
    await atomicWrite(snapshotPath, data);
    return { bytes, path: snapshotPath };
  }

  public async snapshot(sessionId: string): Promise<string | null> {
    try {
      return await fs.readFile(this.#snapshotPath(sessionId), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  public async delete(id: string): Promise<void> {
    await Promise.all([
      fs.rm(this.#recordPath(id), { force: true }),
      fs.rm(this.#snapshotPath(id), { force: true }),
    ]);
  }

  public async markPreviouslyLiveInterrupted(excludeIds: ReadonlySet<string> = new Set()): Promise<StoredSession[]> {
    const records = await this.list();
    const now = new Date().toISOString();
    const changed: StoredSession[] = [];
    for (const record of records) {
      if (record.session.state !== "live" || excludeIds.has(record.session.id)) continue;
      const session: SessionSummary = {
        ...record.session,
        revision: record.session.revision + 1,
        state: "interrupted",
        runtimeId: null,
        endedAt: record.session.endedAt ?? now,
        updatedAt: now,
        viewers: 0,
        controller: null,
      };
      changed.push(await this.save(session, "interrupted", "Agent was not running when this ledger was reopened"));
    }
    return changed;
  }

  #recordPath(id: string): string {
    return path.join(this.#recordsDir, `${id}.json`);
  }

  #snapshotPath(id: string): string {
    return path.join(this.#snapshotsDir, `${id}.ansi`);
  }

  async #readRecord(recordPath: string): Promise<StoredSession | null> {
    try {
      const text = await fs.readFile(recordPath, "utf8");
      return StoredSessionSchema.parse(JSON.parse(text) as unknown);
    } catch (error) {
      if (isMissingFile(error)) return null;
      // A bad/old record must not prevent every other saved session from loading.
      return null;
    }
  }
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
