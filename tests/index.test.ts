import { describe, expect, test } from "bun:test";

// The package's public surface: everything a consumer gets from the entry
// point must actually exist (this guards against the generated stub pattern
// of a test importing a module that is never exported).
import * as scb from "../src/index.js";

describe("public API surface", () => {
  test("exports the runtime classes and helpers", () => {
    expect(typeof scb.CircuitBreaker).toBe("function");
    expect(typeof scb.SlackClient).toBe("function");
    expect(typeof scb.BreakerClient).toBe("function");
    expect(typeof scb.SlackBreaker).toBe("function");
    expect(typeof scb.Outbox).toBe("function");
    expect(typeof scb.loadOutbox).toBe("function");
    expect(typeof scb.loadBreakerState).toBe("function");
    expect(typeof scb.saveBreakerState).toBe("function");
    expect(typeof scb.breakerSummary).toBe("function");
    expect(typeof scb.backoffDelay).toBe("function");
    expect(typeof scb.classify).toBe("function");
    expect(typeof scb.systemClock.now).toBe("function");
    expect(scb.SLACK_API_BASE).toBe("https://slack.com/api");
  });

  test("exports the default option tables", () => {
    expect(scb.DEFAULT_OPTIONS.windowSize).toBeGreaterThan(0);
    expect(scb.DEFAULT_OPTIONS.minimumThroughput).toBeGreaterThan(0);
    expect(scb.DEFAULT_RETRY_POLICY.maxRetries).toBeGreaterThan(0);
  });

  test("exports the error and enum types as values where applicable", () => {
    expect(typeof scb.SlackApiError).toBe("function");
    const err = new scb.SlackApiError("server", "boom", "boom_code");
    expect(err.kind).toBe("server");
    expect(err.code).toBe("boom_code");
    expect(err.name).toBe("SlackApiError");
    expect(scb.classify("channel_not_found")).toBe("permanent");
    expect(scb.classify("rate_limited")).toBe("rate-limited");
  });

  test("a minimal end-to-end flow works through the public surface only", async () => {
    const breaker = new scb.CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 60_000 });
    let fail = true;
    const client = new scb.SlackClient("xoxb-test", {
      fetchImpl: async () => {
        if (fail) throw new TypeError("down");
        return new Response(JSON.stringify({ ok: true, ts: "1" }), { status: 200 });
      },
    });
    const engine = new scb.SlackBreaker(
      new scb.BreakerClient(client, breaker, { retry: { maxRetries: 0, baseDelayMs: 0, random: () => 0 } }),
      new scb.Outbox(null)
    );
    const first = await engine.send("chat.postMessage", { channel: "C1", text: "a" });
    expect(first.queued).toBe(false);
    const second = await engine.send("chat.postMessage", { channel: "C1", text: "b" });
    expect(second.queued).toBe(true);
    expect(engine.outbox.size).toBe(1);
    fail = false;
    engine.reset();
    const report = await engine.drain();
    expect(report.drained).toBe(1);
    expect(report.remaining).toBe(0);
  });
});
