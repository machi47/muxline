import type { CreateSessionRequest, SessionSummary } from "@muxline/protocol";
import type { AgentConfig } from "./config.js";

export class LocalAgentApi {
  readonly #baseUrl: string;
  readonly #token: string;

  public constructor(config: Pick<AgentConfig, "localPort" | "localToken">) {
    this.#baseUrl = `http://127.0.0.1:${config.localPort}`;
    this.#token = config.localToken;
  }

  public async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch(
        `${this.#baseUrl}/health`,
        signal ? { signal } : undefined,
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  public async createSession(request: CreateSessionRequest): Promise<SessionSummary> {
    const response = await this.#request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
    });
    const body = await response.json() as { session?: SessionSummary; error?: string };
    if (!response.ok || !body.session) {
      throw new Error(body.error ?? `Agent returned HTTP ${response.status}`);
    }
    return body.session;
  }

  public async listSessions(): Promise<SessionSummary[]> {
    const response = await this.#request("/v1/sessions");
    const body = await response.json() as { sessions?: SessionSummary[]; error?: string };
    if (!response.ok || !body.sessions) {
      throw new Error(body.error ?? `Agent returned HTTP ${response.status}`);
    }
    return body.sessions;
  }

  public terminalUrl(sessionId: string, clientId: string): string {
    const url = new URL(
      `/v1/sessions/${encodeURIComponent(sessionId)}/terminal`,
      this.#baseUrl,
    );
    url.protocol = "ws:";
    url.searchParams.set("token", this.#token);
    url.searchParams.set("clientId", clientId);
    return url.toString();
  }

  async #request(pathname: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.#baseUrl}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...init.headers,
      },
    });
  }
}
