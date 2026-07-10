import { createHash, randomBytes } from "node:crypto";

export interface AttachmentGrant {
  identityId: string;
  hostId: string;
  sessionId: string;
  expiresAt: number;
}

export class AttachmentNonceStore {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #grants = new Map<string, AttachmentGrant>();

  public constructor(ttlMs = 20_000, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  public create(identityId: string, hostId: string, sessionId: string): {
    nonce: string;
    expiresAt: string;
  } {
    this.#prune();
    const nonce = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + this.#ttlMs;
    this.#grants.set(hash(nonce), { identityId, hostId, sessionId, expiresAt });
    return { nonce, expiresAt: new Date(expiresAt).toISOString() };
  }

  public consume(nonce: string, requestIdentityId?: string): AttachmentGrant | null {
    this.#prune();
    const key = hash(nonce);
    const grant = this.#grants.get(key);
    this.#grants.delete(key);
    if (!grant || grant.expiresAt <= this.#now()) {
      return null;
    }
    if (requestIdentityId && grant.identityId !== requestIdentityId) {
      return null;
    }
    return grant;
  }

  public size(): number {
    this.#prune();
    return this.#grants.size;
  }

  #prune(): void {
    const now = this.#now();
    for (const [key, grant] of this.#grants) {
      if (grant.expiresAt <= now) this.#grants.delete(key);
    }
  }
}

function hash(nonce: string): string {
  return createHash("sha256").update(nonce).digest("base64url");
}
