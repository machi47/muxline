import type { Controller } from "@muxline/protocol";

export interface ClaimResult {
  granted: boolean;
  controller: Controller | null;
  reason?: string;
}

interface LeaseRecord {
  clientId: string;
  source: "local" | "remote";
  acquiredAtMs: number;
  expiresAtMs: number;
}

export class ControlLease {
  readonly #ttlMs: number;
  readonly #now: () => number;
  #lease: LeaseRecord | null = null;

  public constructor(ttlMs = 30_000, now: () => number = Date.now) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000) {
      throw new RangeError("Control lease TTL must be at least one second");
    }
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  public claim(
    clientId: string,
    source: "local" | "remote",
    force = false,
  ): ClaimResult {
    const now = this.#now();
    this.#expire(now);

    if (this.#lease && this.#lease.clientId !== clientId && !force) {
      return {
        granted: false,
        controller: this.current(),
        reason: "Another viewer currently has control",
      };
    }

    const acquiredAtMs = this.#lease?.clientId === clientId
      ? this.#lease.acquiredAtMs
      : now;
    this.#lease = {
      clientId,
      source,
      acquiredAtMs,
      expiresAtMs: now + this.#ttlMs,
    };
    return { granted: true, controller: this.current() };
  }

  public touch(clientId: string): boolean {
    const now = this.#now();
    this.#expire(now);
    if (this.#lease?.clientId !== clientId) {
      return false;
    }
    this.#lease.expiresAtMs = now + this.#ttlMs;
    return true;
  }

  public release(clientId: string): boolean {
    this.#expire(this.#now());
    if (this.#lease?.clientId !== clientId) {
      return false;
    }
    this.#lease = null;
    return true;
  }

  public isHolder(clientId: string): boolean {
    this.#expire(this.#now());
    return this.#lease?.clientId === clientId;
  }

  public current(): Controller | null {
    this.#expire(this.#now());
    if (!this.#lease) {
      return null;
    }
    return {
      clientId: this.#lease.clientId,
      source: this.#lease.source,
      acquiredAt: new Date(this.#lease.acquiredAtMs).toISOString(),
      expiresAt: new Date(this.#lease.expiresAtMs).toISOString(),
    };
  }

  #expire(now: number): void {
    if (this.#lease && this.#lease.expiresAtMs <= now) {
      this.#lease = null;
    }
  }
}
