import { CircuitBreaker } from "./circuit.js";
import { backoffDelay, SlackApiError, SlackClient } from "./slack.js";
import { Clock, systemClock } from "./types.js";

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  random: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxRetries: 3, baseDelayMs: 500, random: Math.random };

/** Why a call failed (or why it never ran). */
export type CallFailureKind = "network" | "rate-limited" | "server" | "permanent" | "circuit-open";

export interface CallOutcome {
  ok: boolean;
  /** The Slack error kind, when the call failed. */
  kind?: CallFailureKind;
  /** Slack error code (e.g. `channel_not_found`), when the API rejected the call. */
  code?: string;
  /** ms actually slept across retries (for tests/demo determinism). */
  waitedMs: number;
  attempts: number;
}

/**
 * A Slack client wrapped in retry-with-backoff and a circuit breaker.
 * Only transport-class failures (network, 429, 5xx) are retried and counted by
 * the breaker; permanent Slack API rejections are surfaced immediately and do
 * not poison the failure rate. When the circuit is open the call fails fast
 * with `kind: "circuit-open"` so callers can fall back without touching the
 * network.
 */
export class BreakerClient {
  readonly breaker: CircuitBreaker;
  readonly client: SlackClient;
  readonly retry: RetryPolicy;
  readonly clock: Clock;

  constructor(client: SlackClient, breaker: CircuitBreaker, opts: { retry?: Partial<RetryPolicy>; clock?: Clock } = {}) {
    this.client = client;
    this.breaker = breaker;
    this.clock = opts.clock ?? systemClock;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...opts.retry };
  }

  async call(method: string, body: Record<string, unknown> = {}): Promise<CallOutcome> {
    let waitedMs = 0;
    let attempts = 0;
    for (;;) {
      const gate = this.breaker.canCall();
      if (!gate.allowed) {
        return { ok: false, kind: "circuit-open", code: "circuit_open", waitedMs, attempts };
      }
      if (gate.state === "half-open" && !this.breaker.beginProbe()) {
        return { ok: false, kind: "circuit-open", code: "circuit_open", waitedMs, attempts };
      }
      attempts += 1;
      let lastError!: SlackApiError;
      try {
        await this.client.call(method, body);
      } catch (err) {
        if (!(err instanceof SlackApiError)) throw err;
        lastError = err;
        if (lastError.kind === "permanent") {
          // A real Slack rejection: do not retry, do not trip the breaker.
          // During a half-open probe the transport just proved healthy, so
          // release the probe slot instead of leaking it.
          this.breaker.abortProbe();
          return { ok: false, kind: lastError.kind, code: lastError.code, waitedMs, attempts };
        }
        this.breaker.recordFailure();
        if (attempts > this.retry.maxRetries) {
          return { ok: false, kind: lastError.kind, code: lastError.code, waitedMs, attempts };
        }
        const delay =
          lastError.kind === "rate-limited" && lastError.retryAfterSec !== undefined
            ? lastError.retryAfterSec * 1000
            : backoffDelay(this.retry.baseDelayMs, attempts - 1, this.retry.random);
        waitedMs += delay;
        await this.clock.sleep(delay);
        continue;
      }
      this.breaker.recordSuccess();
      return { ok: true, waitedMs, attempts };
    }
  }
}
