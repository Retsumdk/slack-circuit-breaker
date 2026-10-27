import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Outbox, loadOutbox } from "../src/outbox.js";
import { breakerSummary, loadBreakerState, saveBreakerState } from "../src/state.js";
import { CircuitBreaker } from "../src/circuit.js";
import { ManualClock } from "./helpers.js";

describe("Outbox", () => {
  test("enqueue assigns deterministic ascending ids and persists", () => {
    const dir = mkdtempSync(join(tmpdir(), "scb-"));
    const path = join(dir, "nested", "outbox.json");
    const outbox = new Outbox(path);
    const a = outbox.enqueue("chat.postMessage", { channel: "C1" }, 1000);
    const b = outbox.enqueue("chat.postMessage", { channel: "C2" }, 2000);
    expect(a.id).toBe("1-1000");
    expect(b.id).toBe("2-2000");
    const reloaded = loadOutbox(path);
    expect(reloaded.size).toBe(2);
    expect(reloaded.peek()!.id).toBe("1-1000");
    rmSync(dir, { recursive: true, force: true });
  });

  test("null path never touches the filesystem", () => {
    const outbox = new Outbox(null);
    outbox.enqueue("chat.postMessage", {}, 1);
    expect(outbox.size).toBe(1);
  });

  test("defer rotates to the back and counts attempts", () => {
    const outbox = new Outbox(null);
    const a = outbox.enqueue("m", { i: 1 }, 1);
    const b = outbox.enqueue("m", { i: 2 }, 2);
    outbox.defer(a);
    expect(outbox.peek()!.id).toBe(b.id);
    expect(a.attempts).toBe(1);
    outbox.defer(a);
    expect(outbox.all()[1]!.attempts).toBe(2);
  });

  test("dequeue removes the message", () => {
    const outbox = new Outbox(null);
    const a = outbox.enqueue("m", {}, 1);
    outbox.dequeue(a);
    expect(outbox.size).toBe(0);
  });

  test("loadOutbox round-trips attempts and continues the id sequence", () => {
    const dir = mkdtempSync(join(tmpdir(), "scb-"));
    const path = join(dir, "outbox.json");
    const first = new Outbox(path);
    first.enqueue("chat.postMessage", { channel: "C1" }, 5);
    first.enqueue("chat.postMessage", { channel: "C2" }, 6);
    const second = loadOutbox(path);
    expect(second.size).toBe(2);
    const next = second.enqueue("chat.postMessage", {}, 7);
    expect(next.id).toBe("3-7");
    rmSync(dir, { recursive: true, force: true });
  });

  test("loadOutbox on a missing file starts fresh", () => {
    const dir = mkdtempSync(join(tmpdir(), "scb-"));
    const outbox = loadOutbox(join(dir, "absent.json"));
    expect(outbox.size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("loadOutbox rejects corrupt JSON and foreign formats", () => {
    const dir = mkdtempSync(join(tmpdir(), "scb-"));
    const path = join(dir, "outbox.json");
    writeFileSync(path, "not json");
    expect(() => loadOutbox(path)).toThrow(/corrupt outbox file/);
    writeFileSync(path, JSON.stringify({ format: "other", version: 1, messages: [] }));
    expect(() => loadOutbox(path)).toThrow(/unrecognized outbox format/);
    writeFileSync(path, JSON.stringify({ format: "slack-circuit-breaker/outbox", version: 1, messages: [{ id: 1 }] }));
    expect(() => loadOutbox(path)).toThrow(/corrupt outbox message/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("breaker state persistence", () => {
  test("save then load restores open state and cooldown", () => {
    const dir = mkdtempSync(join(tmpdir(), "scb-"));
    const path = join(dir, "state.json");
    const clock = new ManualClock(0);
    const writer = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 45_000, clock });
    writer.recordFailure(1_000);
    saveBreakerState(path, writer, 1_000);
    const reader = new CircuitBreaker({ consecutiveFailureThreshold: 1, cooldownMs: 45_000, clock });
    loadBreakerState(path, reader);
    expect(reader.snapshot().state).toBe("open");
    expect(reader.snapshot().openUntil).toBe(46_000);
    expect(reader.canCall().allowed).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("missing state file is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "scb-"));
    const breaker = new CircuitBreaker();
    loadBreakerState(join(dir, "absent.json"), breaker);
    expect(breaker.snapshot().state).toBe("closed");
    rmSync(dir, { recursive: true, force: true });
  });

  test("corrupt or foreign state files are rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "scb-"));
    const path = join(dir, "state.json");
    writeFileSync(path, "{{{");
    const b = new CircuitBreaker();
    expect(() => loadBreakerState(path, b)).toThrow(/corrupt state file/);
    writeFileSync(path, JSON.stringify({ format: "nope", version: 9, breaker: {} }));
    expect(() => loadBreakerState(path, b)).toThrow(/unrecognized breaker state format/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("restore of a closed file resets counters", () => {
    const dir = mkdtempSync(join(tmpdir(), "scb-"));
    const path = join(dir, "state.json");
    const writer = new CircuitBreaker();
    writer.recordSuccess();
    saveBreakerState(path, writer, 42);
    const reader = new CircuitBreaker();
    loadBreakerState(path, reader);
    expect(reader.snapshot().state).toBe("closed");
    expect(reader.snapshot().consecutiveFailures).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("atomic write leaves no temp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "scb-"));
    const path = join(dir, "state.json");
    saveBreakerState(path, new CircuitBreaker(), 1);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("breakerSummary renders a human-readable line", () => {
    const b = new CircuitBreaker();
    b.recordFailure();
    const line = breakerSummary(b.snapshot());
    expect(line).toContain("state=closed");
    expect(line).toContain("failureRate=100%");
    expect(line).toContain("calls=1");
  });
});
