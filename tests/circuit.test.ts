import { describe, expect, test } from "bun:test";
import { CircuitBreaker, DEFAULT_OPTIONS } from "../src/circuit.js";
import type { Clock } from "../src/types.js";

function manualClock(start = 1_700_000_000_000): Clock & { advance(ms: number): void } {
  let t = start;
  return {
    now: () => t,
    sleep: () => Promise.resolve(),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("CircuitBreaker", () => {
  test("starts closed with defaults", () => {
    const b = new CircuitBreaker();
    expect(b.windowSize).toBe(DEFAULT_OPTIONS.windowSize);
    expect(b.cooldownMs).toBe(DEFAULT_OPTIONS.cooldownMs);
    const s = b.snapshot();
    expect(s.state).toBe("closed");
    expect(s.totalCalls).toBe(0);
    expect(s.failureRate).toBe(null);
  });

  test("below minimum throughput never trips on failure rate", () => {
    const b = new CircuitBreaker({ windowSize: 10, minimumThroughput: 5, failureRateThreshold: 0.5 });
    for (let i = 0; i < 4; i += 1) b.recordFailure();
    expect(b.snapshot().state).toBe("closed");
  });

  test("failure rate at threshold trips open", () => {
    const clock = manualClock();
    const b = new CircuitBreaker({
      windowSize: 4,
      minimumThroughput: 4,
      failureRateThreshold: 0.5,
      consecutiveFailureThreshold: 99,
      cooldownMs: 10_000,
      clock,
    });
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    b.recordSuccess();
    expect(b.snapshot().state).toBe("closed");
    b.recordFailure(); // window slides to [S, F, S, F] — failure rate exactly at threshold
    const s = b.snapshot();
    expect(s.state).toBe("open");
    expect(s.failureRate).toBe(0.5);
    expect(s.openUntil).toBe(clock.now() + 10_000);
  });

  test("consecutive failures fast-trip opens immediately", () => {
    const b = new CircuitBreaker({ consecutiveFailureThreshold: 2, minimumThroughput: 100 });
    b.recordFailure();
    expect(b.snapshot().state).toBe("closed");
    b.recordFailure();
    expect(b.snapshot().state).toBe("open");
  });

  test("a success resets the consecutive-failure counter", () => {
    const b = new CircuitBreaker({ consecutiveFailureThreshold: 2, minimumThroughput: 100 });
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    expect(b.snapshot().state).toBe("closed");
    expect(b.snapshot().consecutiveFailures).toBe(1);
  });

  test("open circuit denies calls with retryAfterMs until cooldown elapses", () => {
    const clock = manualClock();
    const b = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 5_000, clock });
    b.recordFailure();
    const denied = b.canCall();
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(5_000);
    clock.advance(4_999);
    expect(b.canCall().allowed).toBe(false);
    clock.advance(1);
    const gate = b.canCall();
    expect(gate.allowed).toBe(true);
    expect(gate.state).toBe("half-open");
  });

  test("half-open admits exactly one probe at a time", () => {
    const clock = manualClock();
    const b = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 1_000, clock });
    b.recordFailure();
    clock.advance(1_000);
    expect(b.canCall().state).toBe("half-open");
    expect(b.beginProbe()).toBe(true);
    const second = b.canCall();
    expect(second.allowed).toBe(false);
    expect(second.state).toBe("half-open");
    b.abortProbe();
    expect(b.beginProbe()).toBe(true);
  });

  test("half-open probe success closes after threshold and clears window", () => {
    const clock = manualClock();
    const b = new CircuitBreaker({
      consecutiveFailureThreshold: 1,
      cooldownMs: 1_000,
      halfOpenSuccessThreshold: 2,
      clock,
    });
    b.recordFailure();
    clock.advance(1_000);
    b.canCall();
    b.beginProbe();
    b.recordSuccess();
    expect(b.snapshot().state).toBe("half-open");
    expect(b.snapshot().halfOpenSuccesses).toBe(1);
    expect(b.beginProbe()).toBe(true);
    b.recordSuccess();
    const s = b.snapshot();
    expect(s.state).toBe("closed");
    expect(s.windowSamples).toBe(0);
    expect(s.halfOpenSuccesses).toBe(0);
  });

  test("half-open probe failure re-opens with a fresh cooldown", () => {
    const clock = manualClock();
    const b = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 1_000, clock });
    b.recordFailure();
    clock.advance(1_000);
    b.canCall();
    b.beginProbe();
    b.recordFailure();
    const s = b.snapshot();
    expect(s.state).toBe("open");
    expect(s.openUntil).toBe(clock.now() + 1_000);
  });

  test("abortProbe releases the slot without recording a call", () => {
    const clock = manualClock();
    const b = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 1_000, clock });
    b.recordFailure();
    clock.advance(1_000);
    b.canCall();
    b.beginProbe();
    b.abortProbe();
    const s = b.snapshot();
    expect(s.state).toBe("half-open");
    expect(s.probeInFlight).toBe(false);
    expect(s.totalCalls).toBe(1);
  });

  test("window slides: old successes age out and a later burst trips", () => {
    const clock = manualClock();
    const b = new CircuitBreaker({
      windowSize: 4,
      minimumThroughput: 4,
      failureRateThreshold: 0.5,
      consecutiveFailureThreshold: 99,
      clock,
    });
    b.recordSuccess();
    b.recordSuccess();
    b.recordSuccess();
    b.recordFailure();
    expect(b.snapshot().failureRate).toBe(0.25);
    b.recordFailure();
    expect(b.snapshot().failureRate).toBe(0.5);
    b.recordFailure();
    b.recordFailure();
    expect(b.snapshot().state).toBe("open");
  });

  test("restore rejects malformed payloads and absurd values", () => {
    const b = new CircuitBreaker();
    expect(() => b.restore({ state: "closed", consecutiveFailures: -1, openUntil: 0, halfOpenSuccesses: 0 })).toThrow();
    expect(() => b.restore({ state: "closed", consecutiveFailures: 1.5, openUntil: 0, halfOpenSuccesses: 0 })).toThrow();
    expect(() => {
      b.restore({ state: "closed", consecutiveFailures: 0, openUntil: 0, halfOpenSuccesses: 0 });
    }).not.toThrow();
  });

  test("restore re-opens after restart so a restart cannot bypass an open circuit", () => {
    const clock = manualClock();
    const first = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 60_000, clock });
    first.recordFailure();
    const persisted = first.snapshot();
    const second = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 60_000, clock });
    second.restore({
      state: persisted.state,
      consecutiveFailures: persisted.consecutiveFailures,
      openUntil: persisted.openUntil,
      halfOpenSuccesses: persisted.halfOpenSuccesses,
    });
    expect(second.snapshot().state).toBe("open");
    expect(second.canCall().allowed).toBe(false);
  });

  test("restore of a half-open state re-opens with remaining cooldown (probe never survives restart)", () => {
    const clock = manualClock();
    const b = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 30_000, clock });
    b.restore({ state: "half-open", consecutiveFailures: 2, openUntil: clock.now() - 1, halfOpenSuccesses: 1 });
    expect(b.snapshot().state).toBe("open");
    expect(b.snapshot().openUntil).toBe(clock.now() + 30_000);
  });

  test("reset closes the breaker and clears counters", () => {
    const b = new CircuitBreaker({ consecutiveFailureThreshold: 1 });
    b.recordFailure();
    b.reset();
    const s = b.snapshot();
    expect(s.state).toBe("closed");
    expect(s.windowSamples).toBe(0);
    expect(s.totalCalls).toBe(1);
    expect(b.canCall().allowed).toBe(true);
  });

  test("failureRate is rounded window over total", () => {
    const b = new CircuitBreaker({ windowSize: 2, minimumThroughput: 100 });
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    expect(b.snapshot().failureRate).toBe(1);
  });
});
