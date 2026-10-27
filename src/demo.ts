#!/usr/bin/env bun
/**
 * Deterministic end-to-end demo: a scripted Slack that fails with network
 * errors, then rate limits, then recovers. The demo walks the full breaker
 * lifecycle — closed → trips open → messages parked in the outbox → cooldown
 * elapses → half-open probe succeeds → closes → outbox drains — on a manual
 * clock so the output is byte-identical on every run (CI enforces this).
 */
import { BreakerClient } from "./breaker-client.js";
import { SlackBreaker } from "./engine.js";
import { Outbox } from "./outbox.js";
import { SlackClient } from "./slack.js";
import { CircuitBreaker } from "./circuit.js";
import { Clock } from "./types.js";

type Scripted = { kind: "fail" } | { kind: "rate" } | { kind: "ok" };

class ManualClock implements Clock {
  private t = 1_700_000_000_000;
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

function line(label: string, detail: string): string {
  return `${label.padEnd(46)}${detail}`;
}

export async function runDemo(log: (s: string) => void): Promise<void> {
  const script: Scripted[] = [
    { kind: "fail" },
    { kind: "fail" },
    { kind: "rate" },
    { kind: "ok" },
    { kind: "ok" },
    { kind: "ok" },
  ];
  let call = 0;
  const fetchImpl = async (): Promise<Response> => {
    const step = script[Math.min(call, script.length - 1)]!;
    call += 1;
    if (step.kind === "fail") throw new TypeError("fetch failed");
    if (step.kind === "rate") {
      return new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "2" },
      });
    }
    return new Response(JSON.stringify({ ok: true, ts: "1700000000.000100" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const clock = new ManualClock();
  const breaker = new CircuitBreaker({
    windowSize: 5,
    minimumThroughput: 3,
    failureRateThreshold: 0.5,
    consecutiveFailureThreshold: 3,
    cooldownMs: 60_000,
    halfOpenSuccessThreshold: 1,
    clock,
  });
  const slack = new SlackClient("xoxb-demo-token", { fetchImpl, clock });
  const breakerClient = new BreakerClient(slack, breaker, {
    retry: { maxRetries: 2, baseDelayMs: 100, random: () => 0 },
    clock,
  });
  const engine = new SlackBreaker(breakerClient, new Outbox(null), { clock });

  const describe = (): string => {
    const s = breaker.snapshot();
    const rate = s.failureRate === null ? "n/a" : `${Math.round(s.failureRate * 100)}%`;
    return `state=${s.state} window=${s.windowSamples} failureRate=${rate}`;
  };

  log("slack-circuit-breaker demo — scripted Slack: 2x network fail, 1x 429, then healthy");
  log("");

  const first = await engine.send("chat.postMessage", { channel: "C123", text: "deploy done" });
  log(line("send #1 (2 network failures + 429)", `ok=${first.ok} code=${first.code} attempts=${first.outcome?.attempts} waited=${first.outcome?.waitedMs}ms`));
  log(line("breaker after send #1", describe()));

  const second = await engine.send("chat.postMessage", { channel: "C123", text: "tests green" });
  log(line("send #2 (circuit now open)", `sent=${second.sent} queued=${second.queued} id=${second.messageId}`));
  log(line("breaker after send #2", describe()));

  const third = await engine.send("chat.postMessage", { channel: "C123", text: "still parked" });
  log(line("send #3 (parked again)", `queued=${third.queued} outbox=${engine.outbox.size}`));

  log("");
  log("cooldown elapses (clock +60s) — next send becomes the half-open probe");
  clock.advance(60_000);
  const probe = await engine.send("chat.postMessage", { channel: "C123", text: "probe" });
  log(line("send #4 (half-open probe)", `ok=${probe.ok} state=${breaker.snapshot().state}`));

  const drain = await engine.drain();
  log(line("drain outbox", `drained=${drain.drained} remaining=${drain.remaining} reason=${drain.stoppedReason}`));
  log(line("final breaker state", describe()));
}
