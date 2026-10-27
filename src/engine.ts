import { BreakerClient, CallFailureKind, CallOutcome } from "./breaker-client.js";
import { CircuitBreaker, CircuitSnapshot } from "./circuit.js";
import { loadOutbox, Outbox, OutboxMessage } from "./outbox.js";
import { SlackClient } from "./slack.js";
import { saveBreakerState } from "./state.js";
import { Clock, systemClock } from "./types.js";

/**
 * High-level facade over a breaker-wrapped Slack client plus a persistent
 * fallback outbox: when the circuit refuses a call, the request is parked in
 * the outbox instead of being lost, and `drain()` replays it once the circuit
 * closes again.
 */
export class SlackBreaker {
  readonly client: BreakerClient;
  readonly outbox: Outbox;
  readonly clock: Clock;
  private readonly statePath: string | null;

  constructor(client: BreakerClient, outbox: Outbox, opts: { clock?: Clock; statePath?: string | null } = {}) {
    this.client = client;
    this.outbox = outbox;
    this.clock = opts.clock ?? systemClock;
    this.statePath = opts.statePath === undefined ? null : opts.statePath;
  }

  /**
   * Convenience constructor: fresh breaker + Slack client + outbox. Pass
   * `statePath`/`outboxPath` to persist across restarts (both null for an
   * in-memory setup, as used in tests and the demo).
   */
  static inMemory(token: string, opts: { breaker?: CircuitBreaker; statePath?: string; outboxPath?: string } = {}): SlackBreaker {
    const breaker = opts.breaker ?? new CircuitBreaker();
    const client = new BreakerClient(new SlackClient(token), breaker);
    const outbox = opts.outboxPath ? loadOutbox(opts.outboxPath) : new Outbox(null);
    return new SlackBreaker(client, outbox, { statePath: opts.statePath ?? null });
  }

  /**
   * Attempt a Slack Web API call. Outcomes:
   * - `sent: true` — delivered (possibly after retries).
   * - `queued: true` — the circuit was open; the request was parked in the
   *   outbox with `code: "circuit_open"`.
   * - otherwise — a permanent Slack rejection (`code` is the Slack error) or
   *   exhausted retries; nothing was queued.
   */
  async send(method: string, body: Record<string, unknown> = {}): Promise<SendResult> {
    const outcome = await this.client.call(method, body);
    this.persist();
    if (outcome.ok) {
      return { sent: true, ok: true, queued: false, outcome, messageId: null, code: undefined, kind: undefined };
    }
    if (outcome.code === "circuit_open") {
      const msg = this.outbox.enqueue(method, body, this.clock.now());
      return { sent: false, ok: false, queued: true, outcome, messageId: msg.id, code: outcome.code, kind: outcome.kind };
    }
    return { sent: false, ok: false, queued: false, outcome, messageId: null, code: outcome.code, kind: outcome.kind };
  }

  /**
   * Replay parked messages oldest-first while the circuit admits calls.
   * A message that fails transiently is deferred (rotated to the back) and
   * draining continues with the next message, so one blip does not block
   * deliveries that would succeed. The sweep stops when the circuit refuses,
   * the `max` budget is spent, the outbox empties, or a full rotation
   * completes without progress — at that point every remaining message has
   * failed at least once this run, so one poison entry cannot spin the loop.
   */
  async drain(max: number = 100): Promise<DrainReport> {
    const report: DrainReport = { drained: 0, remaining: this.outbox.size, stoppedReason: "empty", deferred: 0 };
    const deferredThisRun = new Set<string>();
    let lastFail: string | null = null;
    while (report.drained + report.deferred < max && this.outbox.size > 0) {
      const msg: OutboxMessage | undefined = this.outbox.peek();
      if (!msg) break;
      if (deferredThisRun.has(msg.id)) {
        report.stoppedReason = lastFail !== null ? `failed:${lastFail}` : "drained";
        break;
      }
      const outcome = await this.client.call(msg.method, msg.body);
      if (outcome.code === "circuit_open") {
        report.stoppedReason = "circuit-open";
        break;
      }
      if (outcome.ok) {
        this.outbox.dequeue(msg);
        report.drained += 1;
        report.stoppedReason = this.outbox.size === 0 ? "empty" : "drained";
        continue;
      }
      lastFail = outcome.code ?? outcome.kind ?? "unknown";
      this.outbox.defer(msg);
      deferredThisRun.add(msg.id);
      report.deferred += 1;
      report.stoppedReason = `failed:${lastFail}`;
    }
    report.remaining = this.outbox.size;
    this.persist();
    return report;
  }

  snapshot(): CircuitSnapshot {
    return this.client.breaker.snapshot();
  }

  reset(): void {
    this.client.breaker.reset();
    this.persist();
  }

  private persist(): void {
    if (this.statePath === null) return;
    saveBreakerState(this.statePath, this.client.breaker, this.clock.now());
  }
}

export interface SendResult {
  sent: boolean;
  ok: boolean;
  /** True when the call was parked in the outbox because the circuit was open. */
  queued: boolean;
  outcome: CallOutcome;
  /** Failure kind, mirroring `outcome.kind` for convenience. */
  kind?: CallFailureKind;
  /** Outbox id when queued. */
  messageId: string | null;
  /** Slack error code or `circuit_open`. */
  code?: string;
}

export interface DrainReport {
  drained: number;
  deferred: number;
  remaining: number;
  stoppedReason: "empty" | "drained" | "circuit-open" | `failed:${string}`;
}
