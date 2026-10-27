import { describe, expect, test } from "bun:test";
import { BreakerClient } from "../src/breaker-client.js";
import { CircuitBreaker } from "../src/circuit.js";
import { SlackClient } from "../src/slack.js";
import { systemClock } from "../src/types.js";

/**
 * Script steps operate at the HTTP layer: return a Response (any status) or
 * throw a TypeError to simulate a transport failure. Slack-class errors are
 * simulated with real status codes/bodies so SlackClient's classification
 * (429 Retry-After, ok:false error codes) actually runs, exactly as it does
 * against the real API.
 */
type Behavior = () => Response;

const OK_RESPONSE = () => new Response(JSON.stringify({ ok: true, ts: "1700000000.000100" }), { status: 200 });

function scriptClient(script: Behavior[], opts: { baseUrl?: string } = {}): { client: SlackClient; calls: () => number } {
  let i = 0;
  const fetchImpl = async (): Promise<Response> => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return step!();
  };
  const client = new SlackClient("xoxb-test-token", { fetchImpl, clock: systemClock, ...opts });
  return { client, calls: () => i };
}

const fastRetry = { maxRetries: 2, baseDelayMs: 0, random: () => 0 };

describe("BreakerClient", () => {
  test("success passes through and records", async () => {
    const { client } = scriptClient([OK_RESPONSE]);
    const breaker = new CircuitBreaker();
    const bc = new BreakerClient(client, breaker, { retry: fastRetry });
    const outcome = await bc.call("chat.postMessage", { channel: "C1" });
    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(1);
    expect(breaker.snapshot().totalSuccesses).toBe(1);
  });

  test("transient failures retry then succeed; every failure is recorded", async () => {
    let n = 0;
    const { client, calls } = scriptClient([
      () => {
        n += 1;
        throw new TypeError("fetch failed");
      },
      () => {
        n += 1;
        throw new TypeError("fetch failed");
      },
      OK_RESPONSE,
    ]);
    const breaker = new CircuitBreaker({ consecutiveFailureThreshold: 99 });
    const bc = new BreakerClient(client, breaker, { retry: fastRetry });
    const outcome = await bc.call("chat.postMessage");
    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(3);
    expect(calls()).toBe(3);
    const s = breaker.snapshot();
    expect(s.totalSuccesses).toBe(1);
    expect(s.totalFailures).toBe(2);
    expect(n).toBe(2);
  });

  test("retries stop at maxRetries and report the last failure", async () => {
    const { client, calls } = scriptClient([
      () => {
        throw new TypeError("down");
      },
    ]);
    const breaker = new CircuitBreaker({ consecutiveFailureThreshold: 99 });
    const bc = new BreakerClient(client, breaker, { retry: fastRetry });
    const outcome = await bc.call("chat.postMessage");
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe("network");
    expect(outcome.attempts).toBe(3);
    expect(calls()).toBe(3);
    expect(breaker.snapshot().totalFailures).toBe(3);
  });

  test("rate-limited responses honor Retry-After seconds as the delay", async () => {
    let waited = -1;
    const { client } = scriptClient([
      () => new Response(JSON.stringify({ ok: false, error: "rate_limited" }), { status: 429, headers: { "retry-after": "7" } }),
      OK_RESPONSE,
    ]);
    const clock = { now: () => 0, sleep: (ms: number) => { waited = ms; return Promise.resolve(); } };
    const bc = new BreakerClient(client, new CircuitBreaker({ consecutiveFailureThreshold: 99 }), {
      retry: fastRetry,
      clock,
    });
    const outcome = await bc.call("chat.postMessage");
    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(2);
    expect(waited).toBe(7_000);
    expect(outcome.waitedMs).toBe(7_000);
  });

  test("permanent Slack rejections surface immediately, without retrying or tripping", async () => {
    const { client, calls } = scriptClient([
      () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }),
    ]);
    const breaker = new CircuitBreaker({ consecutiveFailureThreshold: 1 });
    const bc = new BreakerClient(client, breaker, { retry: fastRetry });
    const outcome = await bc.call("chat.postMessage");
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe("permanent");
    expect(outcome.code).toBe("channel_not_found");
    expect(outcome.attempts).toBe(1);
    expect(calls()).toBe(1);
    const s = breaker.snapshot();
    expect(s.state).toBe("closed");
    expect(s.totalFailures).toBe(0);
  });

  test("a permanent rejection during a half-open probe releases the slot", async () => {
    const clock = { now: () => 0, sleep: () => Promise.resolve() };
    const breaker = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 0, halfOpenSuccessThreshold: 1, clock });
    breaker.recordFailure();
    breaker.canCall();
    expect(breaker.snapshot().state).toBe("half-open");
    let throwPermanent = true;
    const { client } = scriptClient([
      () => {
        if (throwPermanent) return new Response(JSON.stringify({ ok: false, error: "msg_too_long" }), { status: 200 });
        return OK_RESPONSE();
      },
    ]);

    const bc = new BreakerClient(client, breaker, { retry: fastRetry, clock });
    const outcome = await bc.call("chat.postMessage");
    expect(outcome.kind).toBe("permanent");
    const s = breaker.snapshot();
    expect(s.probeInFlight).toBe(false);
    expect(s.state).toBe("half-open");
    throwPermanent = false;
    const next = await bc.call("chat.postMessage");
    expect(next.ok).toBe(true);
    expect(breaker.snapshot().state).toBe("closed");
  });

  test("open circuit refuses without touching Slack and reports circuit-open", async () => {
    const { client, calls } = scriptClient([() => {}]);
    const breaker = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 60_000 });
    breaker.recordFailure();
    const bc = new BreakerClient(client, breaker, { retry: fastRetry });
    const outcome = await bc.call("chat.postMessage");
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe("circuit-open");
    expect(outcome.code).toBe("circuit_open");
    expect(calls()).toBe(0);
  });

  test("repeated retry storms trip the breaker and later calls are refused", async () => {
    const { client } = scriptClient([
      () => {
        throw new TypeError("down");
      },
    ]);
    const breaker = new CircuitBreaker({ consecutiveFailureThreshold: 5 });
    const bc = new BreakerClient(client, breaker, { retry: fastRetry });
    await bc.call("chat.postMessage");
    await bc.call("chat.postMessage");
    const third = await bc.call("chat.postMessage");
    expect(third.kind).toBe("circuit-open");
    expect(breaker.snapshot().state).toBe("open");
  });

  test("half-open admission: a second concurrent caller is denied while the probe runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchImpl = async (): Promise<Response> => {
      await gate;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const client = new SlackClient("t", { fetchImpl, clock: systemClock });
    const breaker = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 0, halfOpenSuccessThreshold: 1 });
    breaker.recordFailure();
    breaker.canCall();
    const bc = new BreakerClient(client, breaker, { retry: fastRetry });
    const probe = bc.call("chat.postMessage");
    const denied = await bc.call("chat.postMessage");
    expect(denied.kind).toBe("circuit-open");
    release();
    const probeOutcome = await probe;
    expect(probeOutcome.ok).toBe(true);
    expect(breaker.snapshot().state).toBe("closed");
  });

  test("non-SlackApiError exceptions propagate untouched", async () => {
    // SlackClient classifies every transport error as SlackApiError, so a
    // non-SlackApiError can only originate from a custom client — inject one.
    const client = {
      call: async () => {
        throw new Error("boom");
      },
    } as unknown as SlackClient;
    const bc = new BreakerClient(client, new CircuitBreaker(), { retry: fastRetry });
    try {
      await bc.call("chat.postMessage");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toBe("boom");
    }
  });
});
