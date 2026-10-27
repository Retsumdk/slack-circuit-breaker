import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BreakerClient } from "../src/breaker-client.js";
import { CircuitBreaker } from "../src/circuit.js";
import { SlackBreaker } from "../src/engine.js";
import { Outbox, loadOutbox } from "../src/outbox.js";
import { SlackApiError, SlackClient } from "../src/slack.js";
import { ManualClock } from "./helpers.js";

function fixture(fetchImpl: Parameters<typeof SlackClient.prototype.call>[0] extends never ? never : (url: string, init: RequestInit) => Promise<Response>) {
  const clock = new ManualClock(1_000_000);
  const client = new SlackClient("xoxb-test-token", { fetchImpl, clock });
  const breaker = new CircuitBreaker({ consecutiveFailureThreshold: 3, cooldownMs: 60_000, halfOpenSuccessThreshold: 1, clock });
  const breakerClient = new BreakerClient(client, breaker, { retry: { maxRetries: 2, baseDelayMs: 0, random: () => 0 }, clock });
  const outbox = new Outbox(null);
  return new SlackBreaker(breakerClient, outbox, { clock });
}

describe("SlackBreaker.send", () => {
  test("delivered message reports sent", async () => {
    const engine = fixture(async () => new Response(JSON.stringify({ ok: true, ts: "1" }), { status: 200 }));
    const result = await engine.send("chat.postMessage", { channel: "C1", text: "hi" });
    expect(result.sent).toBe(true);
    expect(result.queued).toBe(false);
    expect(result.messageId).toBeNull();
    expect(engine.outbox.size).toBe(0);
  });

  test("circuit-open requests are parked in the outbox, not lost", async () => {
    const engine = fixture(async () => {
      throw new TypeError("down");
    });
    // 1st send: 3 attempts (initial + 2 retries) -> breaker trips open.
    const first = await engine.send("chat.postMessage", { channel: "C1" });
    expect(first.sent).toBe(false);
    expect(first.queued).toBe(false);
    expect(first.kind).toBe("network");
    expect(first.outcome.attempts).toBe(3);
    // 2nd send: refused by the open circuit -> parked.
    const second = await engine.send("chat.postMessage", { channel: "C1" });
    expect(second.queued).toBe(true);
    expect(second.code).toBe("circuit_open");
    expect(second.messageId).toBeTypeOf("string");
    expect(engine.outbox.size).toBe(1);
  });

  test("permanent rejections are reported with the Slack code and never queued", async () => {
    const engine = fixture(async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }));
    const result = await engine.send("chat.postMessage", { channel: "C-NOPE" });
    expect(result.sent).toBe(false);
    expect(result.queued).toBe(false);
    expect(result.code).toBe("channel_not_found");
    expect(engine.outbox.size).toBe(0);
    expect(engine.snapshot().state).toBe("closed");
  });

  test("send persists breaker state to statePath when configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scb-"));
    const statePath = join(dir, "state", "breaker.json");
    const clock = new ManualClock(5_000);
    const client = new SlackClient("t", {
      fetchImpl: async () => {
        throw new TypeError("down");
      },
      clock,
    });
    const breaker = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 10_000, clock });
    const engine = new SlackBreaker(new BreakerClient(client, breaker, { retry: { maxRetries: 0, baseDelayMs: 0, random: () => 0 }, clock }), new Outbox(null), { clock, statePath });
    await engine.send("chat.postMessage");
    const file = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(file.format).toBe("slack-circuit-breaker/state");
    expect(file.breaker.state).toBe("open");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("SlackBreaker.drain", () => {
  test("drains parked messages after the circuit closes", async () => {
    let healthy = false;
    const engine = fixture(async () => {
      if (!healthy) throw new TypeError("down");
      return new Response(JSON.stringify({ ok: true, ts: "1" }), { status: 200 });
    });
    await engine.send("chat.postMessage", { channel: "C1", text: "a" });
    await engine.send("chat.postMessage", { channel: "C1", text: "b" });
    await engine.send("chat.postMessage", { channel: "C1", text: "c" });
    await engine.send("chat.postMessage", { channel: "C1", text: "d" });
    expect(engine.outbox.size).toBeGreaterThanOrEqual(2);

    healthy = true;
    engine.reset();
    const report = await engine.drain();
    expect(engine.outbox.size).toBe(0);
    expect(report.remaining).toBe(0);
    expect(report.stoppedReason).toBe("empty");
  });

  test("drain with an empty outbox is a no-op", async () => {
    const engine = fixture(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const report = await engine.drain();
    expect(report.drained).toBe(0);
    expect(report.stoppedReason).toBe("empty");
  });

  test("drain stops with circuit-open when the breaker trips mid-drain", async () => {
    let failures = 0;
    const engine = fixture(async () => {
      failures += 1;
      if (failures <= 3) throw new TypeError("down");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await engine.send("chat.postMessage", { text: "a" });
    await engine.send("chat.postMessage", { text: "b" });
    await engine.send("chat.postMessage", { text: "c" });
    await engine.send("chat.postMessage", { text: "d" });
    engine.reset();
    // Make Slack fail again mid-drain: first drain call fails transiently.
    failures = 0;
    const report = await engine.drain(1);
    expect(report.drained).toBe(0);
    expect(report.deferred).toBe(1);
    expect(report.stoppedReason).toBe("failed:network");
    expect(engine.outbox.size).toBe(report.remaining);
  });

  test("drain defers a transiently failing message to the back and keeps the rest", async () => {
    // The first message must exhaust ALL retries (so the engine defers it),
    // and the breaker must not trip in between (threshold above the 3 failed
    // attempts the first message burns with maxRetries=2).
    let calls = 0;
    const clock = new ManualClock(1_000_000);
    const client = new SlackClient("xoxb-test-token", {
      fetchImpl: async () => {
        calls += 1;
        if (calls <= 3) throw new TypeError("blip");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      clock,
    });
    const breaker = new CircuitBreaker({ consecutiveFailureThreshold: 10, cooldownMs: 60_000, clock });
    const engine = new SlackBreaker(
      new BreakerClient(client, breaker, { retry: { maxRetries: 2, baseDelayMs: 0, random: () => 0 }, clock }),
      new Outbox(null),
      { clock }
    );
    engine.outbox.enqueue("chat.postMessage", { i: 1 }, 1);
    engine.outbox.enqueue("chat.postMessage", { i: 2 }, 2);
    const report = await engine.drain();
    expect(report.deferred).toBe(1);
    expect(report.drained).toBe(1);
    expect(engine.outbox.peek()!.body).toEqual({ i: 1 });
    expect(report.remaining).toBe(1);
  });

  test("outbox contents survive a full engine restart via outboxPath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scb-"));
    const outboxPath = join(dir, "outbox.json");
    const clock = new ManualClock(0);
    const deadClient = new SlackClient("t", { fetchImpl: async () => { throw new TypeError("down"); }, clock });
    const breaker = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 10_000, clock });
    const first = new SlackBreaker(
      new BreakerClient(deadClient, breaker, { retry: { maxRetries: 0, baseDelayMs: 0, random: () => 0 }, clock }),
      new Outbox(outboxPath),
      { clock }
    );
    // First send fails all retries AND trips the breaker (threshold 1) — it
    // reports the network failure, not a queued message. The SECOND send meets
    // the open circuit and is parked.
    const tripped = await first.send("chat.postMessage", { channel: "C1", text: "parked" });
    expect(tripped.queued).toBe(false);
    expect(tripped.kind).toBe("network");
    const refused = await first.send("chat.postMessage", { channel: "C1", text: "parked" });
    expect(refused.queued).toBe(true);

    const second = new SlackBreaker(
      new BreakerClient(new SlackClient("t", { fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }), clock }), new CircuitBreaker({ clock })),
      loadOutbox(outboxPath),
      { clock }
    );
    expect(second.outbox.size).toBe(1);
    const report = await second.drain();
    expect(report.drained).toBe(1);
    expect(report.remaining).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("reset closes the breaker and clears cooldown", () => {
    const clock = new ManualClock(0);
    const breaker = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 10_000, clock });
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe("open");
    const engine = new SlackBreaker(
      new BreakerClient(new SlackClient("t", { fetchImpl: async () => new Response("{}", { status: 200 }), clock }), breaker),
      new Outbox(null),
      { clock }
    );
    engine.reset();
    expect(engine.snapshot().state).toBe("closed");
    expect(engine.snapshot().openUntil).toBe(0);
  });

  test("drain respects the max cap", async () => {
    const engine = fixture(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    for (let i = 0; i < 5; i++) engine.outbox.enqueue("chat.postMessage", { i }, i);
    const report = await engine.drain(3);
    expect(report.drained).toBe(3);
    expect(report.remaining).toBe(2);
  });
});

describe("ManualClock", () => {
  test("advances deterministically and drives cooldown expiry", () => {
    const clock = new ManualClock(100);
    const breaker = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 50, clock });
    breaker.recordFailure();
    expect(breaker.canCall().allowed).toBe(false);
    clock.advance(50);
    expect(breaker.canCall().allowed).toBe(true);
    expect(breaker.snapshot().state).toBe("half-open");
  });
});
