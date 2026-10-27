import { Clock, Sample } from "./types.js";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitSnapshot {
  state: CircuitState;
  /** Total calls recorded since the breaker was created (or last reset). */
  totalCalls: number;
  totalSuccesses: number;
  totalFailures: number;
  /** Consecutive failures at the tail of the call sequence. */
  consecutiveFailures: number;
  /** Failure rate across the current window (null when the window is empty). */
  failureRate: number | null;
  windowSamples: number;
  stateChangedAt: number;
  /** When open: epoch ms at which the breaker transitions to half-open. */
  openUntil: number;
  halfOpenSuccesses: number;
  probeInFlight: boolean;
}

export interface CircuitOptions {
  /** Window size for the failure-rate calculation. */
  windowSize?: number;
  /** Minimum window samples before the failure rate can trip the breaker. */
  minimumThroughput?: number;
  /** Failure rate (0..1) at or above which the breaker opens. */
  failureRateThreshold?: number;
  /** Consecutive failures that immediately open the breaker. */
  consecutiveFailureThreshold?: number;
  /** How long the breaker stays open before allowing a half-open probe. */
  cooldownMs?: number;
  /** Half-open successes required before the breaker closes again. */
  halfOpenSuccessThreshold?: number;
  clock?: Clock;
}

export const DEFAULT_OPTIONS = {
  windowSize: 20,
  minimumThroughput: 5,
  failureRateThreshold: 0.5,
  consecutiveFailureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenSuccessThreshold: 2,
};

export class CircuitBreaker {
  readonly windowSize: number;
  readonly minimumThroughput: number;
  readonly failureRateThreshold: number;
  readonly consecutiveFailureThreshold: number;
  readonly cooldownMs: number;
  readonly halfOpenSuccessThreshold: number;

  private readonly clock: Clock;
  private state: CircuitState = "closed";
  private samples: Sample[] = [];
  private openUntil = 0;
  private halfOpenSuccessCount = 0;
  private probeInFlight = false;
  private stateChangedAt: number;
  private totalCalls = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private consecutiveFailures = 0;

  constructor(opts: CircuitOptions = {}) {
    this.windowSize = opts.windowSize ?? DEFAULT_OPTIONS.windowSize;
    this.minimumThroughput = opts.minimumThroughput ?? DEFAULT_OPTIONS.minimumThroughput;
    this.failureRateThreshold = opts.failureRateThreshold ?? DEFAULT_OPTIONS.failureRateThreshold;
    this.consecutiveFailureThreshold = opts.consecutiveFailureThreshold ?? DEFAULT_OPTIONS.consecutiveFailureThreshold;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_OPTIONS.cooldownMs;
    this.halfOpenSuccessThreshold = opts.halfOpenSuccessThreshold ?? DEFAULT_OPTIONS.halfOpenSuccessThreshold;
    this.clock = opts.clock ?? { now: () => Date.now(), sleep: () => Promise.resolve() };
    this.stateChangedAt = this.clock.now();
  }

  /**
   * Ask whether a call may proceed. In the open state this returns
   * `allowed: false` with the ms remaining until the half-open transition.
   * After the cooldown elapses the breaker self-transitions to half-open and
   * admits exactly one probe call; further calls are denied until the probe
   * resolves.
   */
  canCall(): { allowed: boolean; state: CircuitState; retryAfterMs?: number } {
    const now = this.clock.now();
    if (this.state === "open") {
      if (now >= this.openUntil) {
        this.transition("half-open", now);
        this.probeInFlight = false;
      } else {
        return { allowed: false, state: "open", retryAfterMs: this.openUntil - now };
      }
    }
    if (this.state === "half-open" && this.probeInFlight) {
      return { allowed: false, state: "half-open", retryAfterMs: 0 };
    }
    return { allowed: true, state: this.state };
  }

  /** Reserve the half-open probe slot. Returns false if another probe is in flight. */
  beginProbe(): boolean {
    if (this.state !== "half-open" || this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  /**
   * Release the probe slot without recording success or failure. Used when a
   * call ended in a permanent Slack rejection during a half-open probe: the
   * transport is demonstrably healthy (Slack answered), so the probe is
   * neutral. Without this the probe slot would leak and wedge the breaker in
   * half-open forever.
   */
  abortProbe(): void {
    this.probeInFlight = false;
  }

  recordSuccess(at = this.clock.now()): void {
    this.totalCalls += 1;
    this.totalSuccesses += 1;
    this.consecutiveFailures = 0;
    if (this.state === "half-open") {
      this.probeInFlight = false;
      this.halfOpenSuccessCount += 1;
      if (this.halfOpenSuccessCount >= this.halfOpenSuccessThreshold) {
        this.transition("closed", at);
      }
      return;
    }
    this.samples.push({ at, ok: true });
    if (this.samples.length > this.windowSize) this.samples.shift();
  }

  recordFailure(at = this.clock.now()): void {
    this.totalCalls += 1;
    this.totalFailures += 1;
    this.consecutiveFailures += 1;
    if (this.state === "half-open") {
      this.probeInFlight = false;
      this.trip(at);
      return;
    }
    this.samples.push({ at, ok: false });
    if (this.samples.length > this.windowSize) this.samples.shift();
    const rate = this.failureRate();
    const windowFull = this.samples.length >= this.minimumThroughput;
    if (this.consecutiveFailures >= this.consecutiveFailureThreshold || (windowFull && rate !== null && rate >= this.failureRateThreshold)) {
      this.trip(at);
    }
  }

  /**
   * Rehydrate persisted state (from a prior process) into this breaker.
   * Validates every field; the window itself is not persisted — a fresh
   * process starts with an empty window but remembers open/cooldown state so
   * a restart does not instantly re-admit traffic to a failing Slack.
   */
  restore(s: { state: CircuitState; consecutiveFailures: number; openUntil: number; halfOpenSuccesses: number }): void {
    const now = this.clock.now();
    if (!Number.isInteger(s.consecutiveFailures) || s.consecutiveFailures < 0) {
      throw new Error(`invalid consecutiveFailures: ${s.consecutiveFailures}`);
    }
    if (!Number.isInteger(s.openUntil) || s.openUntil < 0) {
      throw new Error(`invalid openUntil: ${s.openUntil}`);
    }
    if (!Number.isInteger(s.halfOpenSuccesses) || s.halfOpenSuccesses < 0) {
      throw new Error(`invalid halfOpenSuccesses: ${s.halfOpenSuccesses}`);
    }
    this.consecutiveFailures = s.consecutiveFailures;
    this.halfOpenSuccessCount = s.halfOpenSuccesses;
    this.openUntil = s.openUntil;
    if (s.state === "open" && now < this.openUntil) {
      this.state = "open";
      this.stateChangedAt = now;
    } else if (s.state === "half-open") {
      // A probe never survives a restart: re-open with the remaining cooldown.
      this.state = "open";
      this.stateChangedAt = now;
      if (this.openUntil <= now) this.openUntil = now + this.cooldownMs;
    } else if (s.state === "closed") {
      this.state = "closed";
      this.stateChangedAt = now;
      this.consecutiveFailures = 0;
      this.openUntil = 0;
    } else if (s.state === "open") {
      // The cooldown elapsed while the process was down: keep the breaker
      // open with openUntil pinned to now so the next canCall() takes the
      // normal half-open path (one probe) instead of blind-admitting traffic.
      this.state = "open";
      this.stateChangedAt = now;
      this.openUntil = Math.max(this.openUntil, now);
    } else {
      throw new Error(`invalid state: ${s.state}`);
    }
  }

  /** Manually close the breaker and clear the window (operator reset). */
  reset(at = this.clock.now()): void {
    this.samples = [];
    this.halfOpenSuccessCount = 0;
    this.probeInFlight = false;
    this.openUntil = 0;
    this.consecutiveFailures = 0;
    this.transition("closed", at);
  }

  snapshot(): CircuitSnapshot {
    return {
      state: this.state,
      totalCalls: this.totalCalls,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      consecutiveFailures: this.consecutiveFailures,
      failureRate: this.failureRate(),
      windowSamples: this.samples.length,
      stateChangedAt: this.stateChangedAt,
      openUntil: this.state === "open" ? this.openUntil : 0,
      halfOpenSuccesses: this.halfOpenSuccessCount,
      probeInFlight: this.probeInFlight,
    };
  }

  failureRate(): number | null {
    if (this.samples.length === 0) return null;
    const failures = this.samples.filter((s) => !s.ok).length;
    return failures / this.samples.length;
  }

  private trip(at: number): void {
    this.openUntil = at + this.cooldownMs;
    this.halfOpenSuccessCount = 0;
    this.transition("open", at);
  }

  private transition(to: CircuitState, at: number): void {
    if (this.state === to) return;
    this.state = to;
    this.stateChangedAt = at;
    if (to === "closed") {
      this.samples = [];
      this.halfOpenSuccessCount = 0;
      this.openUntil = 0;
    }
  }
}
