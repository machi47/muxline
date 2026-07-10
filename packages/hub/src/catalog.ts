import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SessionSummarySchema, type SessionSummary } from "@muxline/protocol";

const PersistedHostSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  platform: z.string().min(1).max(100),
  agentVersion: z.string().min(1).max(100),
  lastSeenAt: z.string().datetime(),
  sessions: z.array(SessionSummarySchema),
});

const CatalogFileSchema = z.object({
  version: z.literal(1),
  hosts: z.array(PersistedHostSchema),
});

export interface PersistedHost {
  id: string;
  name: string;
  platform: string;
  agentVersion: string;
  lastSeenAt: string;
  sessions: SessionSummary[];
}

/**
 * The M1/Hub keeps only the session catalogue and last rendered screen needed
 * for offline inspection. It never receives argv, environments, or full native
 * Claude/Codex transcripts.
 */
export class HubCatalog {
  readonly #root: string;
  readonly #file: string;
  readonly #snapshotDir: string;
  readonly #hosts = new Map<string, PersistedHost>();
  #saveTimer: NodeJS.Timeout | null = null;
  #write: Promise<void> = Promise.resolve();

  public constructor(dataDir: string) {
    this.#root = path.join(dataDir, "catalog");
    this.#file = path.join(this.#root, "catalog.json");
    this.#snapshotDir = path.join(this.#root, "snapshots");
  }

  public async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.#root, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.#snapshotDir, { recursive: true, mode: 0o700 }),
    ]);
    try {
      const parsed = CatalogFileSchema.parse(JSON.parse(await fs.readFile(this.#file, "utf8")) as unknown);
      for (const host of parsed.hosts) {
        this.#hosts.set(host.id, { ...host, sessions: host.sessions });
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        // An unreadable catalogue should not prevent current live sessions from reconnecting.
      }
    }
  }

  public upsertHost(input: Omit<PersistedHost, "sessions" | "lastSeenAt">): PersistedHost {
    const existing = this.#hosts.get(input.id);
    const host: PersistedHost = {
      ...input,
      lastSeenAt: new Date().toISOString(),
      sessions: existing?.sessions ?? [],
    };
    this.#hosts.set(host.id, host);
    this.#scheduleSave();
    return host;
  }

  public touchHost(id: string): void {
    const existing = this.#hosts.get(id);
    if (!existing) return;
    existing.lastSeenAt = new Date().toISOString();
    this.#scheduleSave();
  }

  public upsertSession(session: SessionSummary): void {
    const host = this.#hosts.get(session.hostId);
    if (!host) return;
    const index = host.sessions.findIndex((candidate) => candidate.id === session.id);
    const existing = index >= 0 ? host.sessions[index] : undefined;
    if (existing && existing.revision > session.revision) return;
    if (index >= 0) host.sessions[index] = session;
    else host.sessions.push(session);
    host.lastSeenAt = new Date().toISOString();
    this.#scheduleSave();
  }

  public hosts(): PersistedHost[] {
    return [...this.#hosts.values()]
      .map((host) => ({ ...host, sessions: [...host.sessions] }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public session(hostId: string, sessionId: string): SessionSummary | null {
    return this.#hosts.get(hostId)?.sessions.find((session) => session.id === sessionId) ?? null;
  }

  public async saveSnapshot(input: {
    hostId: string;
    sessionId: string;
    revision: number;
    capturedAt: string;
    sequence: number;
    data: string;
  }): Promise<void> {
    const session = this.session(input.hostId, input.sessionId);
    if (!session || session.revision > input.revision) return;
    const bytes = Buffer.byteLength(input.data, "utf8");
    if (bytes > 8 * 1024 * 1024) return;
    await atomicWrite(this.#snapshotPath(input.hostId, input.sessionId), input.data);
    const updated: SessionSummary = {
      ...session,
      revision: Math.max(session.revision, input.revision),
      snapshot: {
        available: true,
        capturedAt: input.capturedAt,
        bytes,
        sequence: input.sequence,
      },
    };
    this.upsertSession(updated);
  }

  public async snapshot(hostId: string, sessionId: string): Promise<string | null> {
    try {
      return await fs.readFile(this.#snapshotPath(hostId, sessionId), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  public async close(): Promise<void> {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    await this.#write;
    await this.#writeNow();
  }

  #scheduleSave(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void this.#writeNow();
    }, 150);
    this.#saveTimer.unref();
  }

  async #writeNow(): Promise<void> {
    const data = CatalogFileSchema.parse({ version: 1, hosts: this.hosts() });
    this.#write = this.#write
      .catch(() => undefined)
      .then(() => atomicWrite(this.#file, `${JSON.stringify(data, null, 2)}\n`));
    await this.#write;
  }

  #snapshotPath(hostId: string, sessionId: string): string {
    return path.join(this.#snapshotDir, `${hostId}-${sessionId}.ansi`);
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
