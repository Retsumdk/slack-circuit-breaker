import { Clock, systemClock } from "./types.js";

export type FailureKind = "network" | "rate-limited" | "server" | "permanent";

export class SlackApiError extends Error {
  readonly kind: FailureKind;
  readonly code?: string;
  /** Seconds to wait, from a 429 Retry-After header when present. */
  readonly retryAfterSec?: number;

  constructor(kind: FailureKind, message: string, code?: string, retryAfterSec?: number) {
    super(message);
    this.name = "SlackApiError";
    this.kind = kind;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Slack errors that will never succeed on retry regardless of circuit state. */
const PERMANENT_ERRORS = new Set([
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "channel_not_found",
  "is_archived",
  "not_in_channel",
  "msg_too_long",
  "no_text",
  "method_not_supported",
  "access_denied",
]);

export function classify(code: string): FailureKind {
  return PERMANENT_ERRORS.has(code) ? "permanent" : code === "rate_limited" ? "rate-limited" : "server";
}

export const SLACK_API_BASE = "https://slack.com/api";

export class SlackClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly clock: Clock;

  constructor(token: string, opts: { baseUrl?: string; fetchImpl?: FetchLike; clock?: Clock } = {}) {
    this.token = token;
    this.baseUrl = opts.baseUrl ?? SLACK_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.clock = opts.clock ?? systemClock;
  }

  async call(method: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new SlackApiError("network", err instanceof Error ? err.message : String(err));
    }

    if (response.status === 429) {
      const ra = response.headers.get("retry-after");
      const retryAfterSec = ra !== null ? Number(ra) : undefined;
      throw new SlackApiError(
        "rate-limited",
        `rate limited${retryAfterSec !== undefined ? `: retry after ${retryAfterSec}s` : ""}`,
        "rate_limited",
        retryAfterSec
      );
    }
    if (response.status >= 500) {
      throw new SlackApiError("server", `slack returned HTTP ${response.status}`);
    }
    if (response.status >= 400) {
      throw new SlackApiError("permanent", `slack returned HTTP ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SlackApiError("server", "slack returned a non-JSON body");
    }
    const obj = payload as { ok?: boolean; error?: string } | null;
    if (!obj || obj.ok !== true) {
      const code = obj?.error ?? "unknown_error";
      const kind = classify(code);
      throw new SlackApiError(kind, `slack error: ${code}`, code);
    }
    return obj as Record<string, unknown>;
  }
}

/** Exponential backoff with full jitter: delay ∈ [0, base * 2^attempt]. */
export function backoffDelay(baseMs: number, attempt: number, random: () => number = Math.random): number {
  return Math.floor(random() * baseMs * 2 ** attempt);
}
