var __esm = (fn, res, err) => () => {
  if (fn)
    try {
      res = fn(fn = 0);
    } catch (e) {
      err = [e];
    }
  if (err)
    throw err[0];
  return res;
};

// src/types.ts
var systemClock;
var init_types = __esm(() => {
  systemClock = {
    now: () => Date.now(),
    sleep: (ms) => ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()
  };
});

// src/slack.ts
function classify(code) {
  return PERMANENT_ERRORS.has(code) ? "permanent" : code === "rate_limited" ? "rate-limited" : "server";
}

class SlackClient {
  token;
  baseUrl;
  fetchImpl;
  clock;
  constructor(token, opts = {}) {
    this.token = token;
    this.baseUrl = opts.baseUrl ?? SLACK_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.clock = opts.clock ?? systemClock;
  }
  async call(method, body = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${this.token}`
        },
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw new SlackApiError("network", err instanceof Error ? err.message : String(err));
    }
    if (response.status === 429) {
      const ra = response.headers.get("retry-after");
      const retryAfterSec = ra !== null ? Number(ra) : undefined;
      throw new SlackApiError("rate-limited", `rate limited${retryAfterSec !== undefined ? `: retry after ${retryAfterSec}s` : ""}`, "rate_limited", retryAfterSec);
    }
    if (response.status >= 500) {
      throw new SlackApiError("server", `slack returned HTTP ${response.status}`);
    }
    if (response.status >= 400) {
      throw new SlackApiError("permanent", `slack returned HTTP ${response.status}`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new SlackApiError("server", "slack returned a non-JSON body");
    }
    const obj = payload;
    if (!obj || obj.ok !== true) {
      const code = obj?.error ?? "unknown_error";
      const kind = classify(code);
      throw new SlackApiError(kind, `slack error: ${code}`, code);
    }
    return obj;
  }
}
function backoffDelay(baseMs, attempt, random = Math.random) {
  return Math.floor(random() * baseMs * 2 ** attempt);
}
var SlackApiError, PERMANENT_ERRORS, SLACK_API_BASE = "https://slack.com/api";
var init_slack = __esm(() => {
  init_types();
  SlackApiError = class SlackApiError extends Error {
    kind;
    code;
    retryAfterSec;
    constructor(kind, message, code, retryAfterSec) {
      super(message);
      this.name = "SlackApiError";
      this.kind = kind;
      this.code = code;
      this.retryAfterSec = retryAfterSec;
    }
  };
  PERMANENT_ERRORS = new Set([
    "invalid_auth",
    "account_inactive",
    "token_revoked",
    "channel_not_found",
    "is_archived",
    "not_in_channel",
    "msg_too_long",
    "no_text",
    "method_not_supported",
    "access_denied"
  ]);
});

// src/breaker-client.ts
class BreakerClient {
  breaker;
  client;
  retry;
  clock;
  constructor(client, breaker, opts = {}) {
    this.client = client;
    this.breaker = breaker;
    this.clock = opts.clock ?? systemClock;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...opts.retry };
  }
  async call(method, body = {}) {
    let waitedMs = 0;
    let attempts = 0;
    for (;; ) {
      const gate = this.breaker.canCall();
      if (!gate.allowed) {
        return { ok: false, kind: "circuit-open", code: "circuit_open", waitedMs, attempts };
      }
      if (gate.state === "half-open" && !this.breaker.beginProbe()) {
        return { ok: false, kind: "circuit-open", code: "circuit_open", waitedMs, attempts };
      }
      attempts += 1;
      let lastError;
      try {
        await this.client.call(method, body);
      } catch (err) {
        if (!(err instanceof SlackApiError))
          throw err;
        lastError = err;
        if (lastError.kind === "permanent") {
          this.breaker.abortProbe();
          return { ok: false, kind: lastError.kind, code: lastError.code, waitedMs, attempts };
        }
        this.breaker.recordFailure();
        if (attempts > this.retry.maxRetries) {
          return { ok: false, kind: lastError.kind, code: lastError.code, waitedMs, attempts };
        }
        const delay = lastError.kind === "rate-limited" && lastError.retryAfterSec !== undefined ? lastError.retryAfterSec * 1000 : backoffDelay(this.retry.baseDelayMs, attempts - 1, this.retry.random);
        waitedMs += delay;
        await this.clock.sleep(delay);
        continue;
      }
      this.breaker.recordSuccess();
      return { ok: true, waitedMs, attempts };
    }
  }
}
var DEFAULT_RETRY_POLICY;
var init_breaker_client = __esm(() => {
  init_slack();
  init_types();
  DEFAULT_RETRY_POLICY = { maxRetries: 3, baseDelayMs: 500, random: Math.random };
});

// src/circuit.ts
class CircuitBreaker {
  windowSize;
  minimumThroughput;
  failureRateThreshold;
  consecutiveFailureThreshold;
  cooldownMs;
  halfOpenSuccessThreshold;
  clock;
  state = "closed";
  samples = [];
  openUntil = 0;
  halfOpenSuccessCount = 0;
  probeInFlight = false;
  stateChangedAt;
  totalCalls = 0;
  totalSuccesses = 0;
  totalFailures = 0;
  consecutiveFailures = 0;
  constructor(opts = {}) {
    this.windowSize = opts.windowSize ?? DEFAULT_OPTIONS.windowSize;
    this.minimumThroughput = opts.minimumThroughput ?? DEFAULT_OPTIONS.minimumThroughput;
    this.failureRateThreshold = opts.failureRateThreshold ?? DEFAULT_OPTIONS.failureRateThreshold;
    this.consecutiveFailureThreshold = opts.consecutiveFailureThreshold ?? DEFAULT_OPTIONS.consecutiveFailureThreshold;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_OPTIONS.cooldownMs;
    this.halfOpenSuccessThreshold = opts.halfOpenSuccessThreshold ?? DEFAULT_OPTIONS.halfOpenSuccessThreshold;
    this.clock = opts.clock ?? { now: () => Date.now(), sleep: () => Promise.resolve() };
    this.stateChangedAt = this.clock.now();
  }
  canCall() {
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
  beginProbe() {
    if (this.state !== "half-open" || this.probeInFlight)
      return false;
    this.probeInFlight = true;
    return true;
  }
  abortProbe() {
    this.probeInFlight = false;
  }
  recordSuccess(at = this.clock.now()) {
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
    if (this.samples.length > this.windowSize)
      this.samples.shift();
  }
  recordFailure(at = this.clock.now()) {
    this.totalCalls += 1;
    this.totalFailures += 1;
    this.consecutiveFailures += 1;
    if (this.state === "half-open") {
      this.probeInFlight = false;
      this.trip(at);
      return;
    }
    this.samples.push({ at, ok: false });
    if (this.samples.length > this.windowSize)
      this.samples.shift();
    const rate = this.failureRate();
    const windowFull = this.samples.length >= this.minimumThroughput;
    if (this.consecutiveFailures >= this.consecutiveFailureThreshold || windowFull && rate !== null && rate >= this.failureRateThreshold) {
      this.trip(at);
    }
  }
  restore(s) {
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
      this.state = "open";
      this.stateChangedAt = now;
      if (this.openUntil <= now)
        this.openUntil = now + this.cooldownMs;
    } else if (s.state === "closed") {
      this.state = "closed";
      this.stateChangedAt = now;
      this.consecutiveFailures = 0;
      this.openUntil = 0;
    } else if (s.state === "open") {
      this.state = "open";
      this.stateChangedAt = now;
      this.openUntil = Math.max(this.openUntil, now);
    } else {
      throw new Error(`invalid state: ${s.state}`);
    }
  }
  reset(at = this.clock.now()) {
    this.samples = [];
    this.halfOpenSuccessCount = 0;
    this.probeInFlight = false;
    this.openUntil = 0;
    this.consecutiveFailures = 0;
    this.transition("closed", at);
  }
  snapshot() {
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
      probeInFlight: this.probeInFlight
    };
  }
  failureRate() {
    if (this.samples.length === 0)
      return null;
    const failures = this.samples.filter((s) => !s.ok).length;
    return failures / this.samples.length;
  }
  trip(at) {
    this.openUntil = at + this.cooldownMs;
    this.halfOpenSuccessCount = 0;
    this.transition("open", at);
  }
  transition(to, at) {
    if (this.state === to)
      return;
    this.state = to;
    this.stateChangedAt = at;
    if (to === "closed") {
      this.samples = [];
      this.halfOpenSuccessCount = 0;
      this.openUntil = 0;
    }
  }
}
var DEFAULT_OPTIONS;
var init_circuit = __esm(() => {
  DEFAULT_OPTIONS = {
    windowSize: 20,
    minimumThroughput: 5,
    failureRateThreshold: 0.5,
    consecutiveFailureThreshold: 5,
    cooldownMs: 30000,
    halfOpenSuccessThreshold: 2
  };
});

// src/outbox.ts
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { dirname } from "path";

class Outbox {
  path;
  messages = [];
  nextId = 1;
  constructor(path) {
    this.path = path;
  }
  enqueue(method, body, at) {
    const msg = { id: `${this.nextId++}-${at}`, method, body, enqueuedAt: at, attempts: 0 };
    this.messages.push(msg);
    this.persist();
    return msg;
  }
  peek() {
    return this.messages[0];
  }
  defer(msg) {
    msg.attempts += 1;
    this.messages = this.messages.filter((m) => m.id !== msg.id);
    this.messages.push(msg);
    this.persist();
  }
  dequeue(msg) {
    this.messages = this.messages.filter((m) => m.id !== msg.id);
    this.persist();
  }
  get size() {
    return this.messages.length;
  }
  all() {
    return this.messages;
  }
  static load(path) {
    if (!existsSync(path))
      return new Outbox(path);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch (err) {
      throw new Error(`corrupt outbox file ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const file = parsed;
    if (!file || file.format !== OUTBOX_FORMAT || file.version !== 1 || !Array.isArray(file.messages)) {
      throw new Error(`unrecognized outbox format in ${path}`);
    }
    const outbox = new Outbox(path);
    for (const raw of file.messages) {
      const msg = raw;
      if (typeof msg?.id !== "string" || typeof msg.method !== "string" || typeof msg.body !== "object" || msg.body === null) {
        throw new Error(`corrupt outbox message in ${path}`);
      }
      const restored = { id: msg.id, method: msg.method, body: msg.body, enqueuedAt: typeof msg.enqueuedAt === "number" ? msg.enqueuedAt : 0, attempts: typeof msg.attempts === "number" ? msg.attempts : 0 };
      outbox.messages.push(restored);
      const seq = Number(restored.id.split("-")[0]);
      if (Number.isFinite(seq) && seq >= outbox.nextId)
        outbox.nextId = seq + 1;
    }
    return outbox;
  }
  persist() {
    if (this.path === null)
      return;
    const file = { format: OUTBOX_FORMAT, version: 1, messages: this.messages };
    const tmp = `${this.path}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(file, null, 2));
    renameSync(tmp, this.path);
  }
}
function loadOutbox(path) {
  return Outbox.load(path);
}
var OUTBOX_FORMAT = "slack-circuit-breaker/outbox";
var init_outbox = () => {};

// src/state.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2, renameSync as renameSync2 } from "fs";
import { dirname as dirname2 } from "path";
function saveBreakerState(path, breaker, updatedAt) {
  const snap = breaker.snapshot();
  const file = {
    format: STATE_FORMAT,
    version: 1,
    breaker: {
      state: snap.state,
      consecutiveFailures: snap.consecutiveFailures,
      openUntil: snap.openUntil,
      halfOpenSuccesses: snap.halfOpenSuccesses
    },
    updatedAt
  };
  const tmp = `${path}.tmp`;
  mkdirSync2(dirname2(path), { recursive: true });
  writeFileSync2(tmp, JSON.stringify(file, null, 2));
  renameSync2(tmp, path);
}
function loadBreakerState(path, breaker) {
  if (!existsSync2(path))
    return;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync2(path, "utf-8"));
  } catch (err) {
    throw new Error(`corrupt state file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const file = parsed;
  if (!file || file.format !== STATE_FORMAT || file.version !== 1) {
    throw new Error(`unrecognized breaker state format in ${path}`);
  }
  breaker.restore(file.breaker);
}
function breakerSummary(snap) {
  const rate = snap.failureRate === null ? "n/a" : `${Math.round(snap.failureRate * 100)}%`;
  return `state=${snap.state} window=${snap.windowSamples} failureRate=${rate} calls=${snap.totalCalls} failures=${snap.totalFailures}`;
}
var STATE_FORMAT = "slack-circuit-breaker/state";
var init_state = () => {};

// src/engine.ts
class SlackBreaker {
  client;
  outbox;
  clock;
  statePath;
  constructor(client, outbox, opts = {}) {
    this.client = client;
    this.outbox = outbox;
    this.clock = opts.clock ?? systemClock;
    this.statePath = opts.statePath === undefined ? null : opts.statePath;
  }
  static inMemory(token, opts = {}) {
    const breaker = opts.breaker ?? new CircuitBreaker;
    const client = new BreakerClient(new SlackClient(token), breaker);
    const outbox = opts.outboxPath ? loadOutbox(opts.outboxPath) : new Outbox(null);
    return new SlackBreaker(client, outbox, { statePath: opts.statePath ?? null });
  }
  async send(method, body = {}) {
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
  async drain(max = 100) {
    const report = { drained: 0, remaining: this.outbox.size, stoppedReason: "empty", deferred: 0 };
    const deferredThisRun = new Set;
    let lastFail = null;
    while (report.drained + report.deferred < max && this.outbox.size > 0) {
      const msg = this.outbox.peek();
      if (!msg)
        break;
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
  snapshot() {
    return this.client.breaker.snapshot();
  }
  reset() {
    this.client.breaker.reset();
    this.persist();
  }
  persist() {
    if (this.statePath === null)
      return;
    saveBreakerState(this.statePath, this.client.breaker, this.clock.now());
  }
}
var init_engine = __esm(() => {
  init_breaker_client();
  init_circuit();
  init_outbox();
  init_slack();
  init_state();
  init_types();
});

// src/demo.ts
class ManualClock {
  t = 1700000000000;
  now() {
    return this.t;
  }
  async sleep(ms) {
    this.t += ms;
  }
  advance(ms) {
    this.t += ms;
  }
}
function line(label, detail) {
  return `${label.padEnd(46)}${detail}`;
}
async function runDemo(log) {
  const script = [
    { kind: "fail" },
    { kind: "fail" },
    { kind: "rate" },
    { kind: "ok" },
    { kind: "ok" },
    { kind: "ok" }
  ];
  let call = 0;
  const fetchImpl = async () => {
    const step = script[Math.min(call, script.length - 1)];
    call += 1;
    if (step.kind === "fail")
      throw new TypeError("fetch failed");
    if (step.kind === "rate") {
      return new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "2" }
      });
    }
    return new Response(JSON.stringify({ ok: true, ts: "1700000000.000100" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const clock = new ManualClock;
  const breaker = new CircuitBreaker({
    windowSize: 5,
    minimumThroughput: 3,
    failureRateThreshold: 0.5,
    consecutiveFailureThreshold: 3,
    cooldownMs: 60000,
    halfOpenSuccessThreshold: 1,
    clock
  });
  const slack = new SlackClient("xoxb-demo-token", { fetchImpl, clock });
  const breakerClient = new BreakerClient(slack, breaker, {
    retry: { maxRetries: 2, baseDelayMs: 100, random: () => 0 },
    clock
  });
  const engine = new SlackBreaker(breakerClient, new Outbox(null), { clock });
  const describe = () => {
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
  clock.advance(60000);
  const probe = await engine.send("chat.postMessage", { channel: "C123", text: "probe" });
  log(line("send #4 (half-open probe)", `ok=${probe.ok} state=${breaker.snapshot().state}`));
  const drain = await engine.drain();
  log(line("drain outbox", `drained=${drain.drained} remaining=${drain.remaining} reason=${drain.stoppedReason}`));
  log(line("final breaker state", describe()));
}
var init_demo = __esm(() => {
  init_breaker_client();
  init_engine();
  init_outbox();
  init_slack();
  init_circuit();
});

// src/cli.ts
init_breaker_client();
init_circuit();
init_engine();
init_outbox();
init_slack();
init_state();
init_types();
var USAGE = `scb — Slack circuit breaker

Usage:
  scb demo
  scb send <method> [--channel <id>] [--text <text>] [--token-env <name>] [--state <file>] [--outbox <file>] [--json]
  scb status [--state <file>] [--outbox <file>] [--json]
  scb drain [--token-env <name>] [--state <file>] [--outbox <file>] [--max <n>] [--json]

Commands:
  demo     Deterministic lifecycle walkthrough (no network, no token).
  send     Call a Slack Web API method through the breaker. Requires a token
           in the environment (default env var: SLACK_BOT_TOKEN).
  status   Print breaker state and outbox size from the state files.
  drain    Replay parked outbox messages while the circuit is closed.

Exit codes: 0 ok · 1 error · 2 circuit open / nothing to drain.`;
function parseFlags(args) {
  const flags = {};
  for (let i = 0;i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--"))
      continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}
function tokenFrom(envName) {
  const token = process.env[envName];
  if (!token || token.length === 0) {
    throw new Error(`no token: set ${envName} in the environment`);
  }
  return token;
}
function buildEngine(token, statePath, outboxPath, clock = systemClock) {
  const breaker = new CircuitBreaker({ clock });
  if (statePath !== null)
    loadBreakerState(statePath, breaker);
  const outbox = outboxPath !== null ? loadOutbox(outboxPath) : new Outbox(null);
  const slack = new SlackClient(token, { clock });
  return new SlackBreaker(new BreakerClient(slack, breaker), outbox, { clock, statePath });
}
async function runCli(argv, io) {
  const [command = "", ...rest] = argv;
  try {
    if (command === "help" || command === "--help" || command === "") {
      io.out(USAGE);
      return command === "" && rest.length === 0 ? 1 : 0;
    }
    if (command === "demo") {
      await Promise.resolve().then(() => init_demo());
      await runDemo(io.out);
      return 0;
    }
    if (command === "status") {
      const flags = parseFlags(rest);
      const statePath = typeof flags.state === "string" ? flags.state : "slack-breaker-state.json";
      const outboxPath = typeof flags.outbox === "string" ? flags.outbox : "slack-breaker-outbox.json";
      const breaker = new CircuitBreaker;
      if (statePath !== null)
        loadBreakerState(statePath, breaker);
      const snap = breaker.snapshot();
      const outbox = loadOutbox(outboxPath);
      if (flags.json === true) {
        io.out(JSON.stringify({ breaker: snap, outboxSize: outbox.size, stateFile: statePath }, null, 2));
      } else {
        io.out(`state file: ${statePath}`);
        io.out(`breaker: ${breakerSummary(snap)}`);
        io.out(`outbox: ${outbox.size} parked message(s)`);
      }
      return 0;
    }
    if (command === "send") {
      const flags = parseFlags(rest);
      const positional = rest.filter((a) => !a.startsWith("--") && a !== flags.channel && a !== flags.text);
      const method = positional[0];
      if (!method)
        throw new Error("usage: scb send <method> [flags]");
      const tokenEnv = typeof flags["token-env"] === "string" ? flags["token-env"] : "SLACK_BOT_TOKEN";
      const statePath = typeof flags.state === "string" ? flags.state : "slack-breaker-state.json";
      const outboxPath = typeof flags.outbox === "string" ? flags.outbox : "slack-breaker-outbox.json";
      const body = {};
      if (typeof flags.channel === "string")
        body.channel = flags.channel;
      if (typeof flags.text === "string")
        body.text = flags.text;
      const engine = buildEngine(tokenFrom(tokenEnv), statePath, outboxPath);
      const result = await engine.send(method, body);
      if (flags.json === true) {
        io.out(JSON.stringify({ ...result, outcome: { ...result.outcome, kind: result.outcome.kind ?? null, code: result.outcome.code ?? null } }, null, 2));
      } else {
        io.out(`method=${method} sent=${result.sent} queued=${result.queued} code=${result.code ?? "ok"}`);
      }
      if (result.queued)
        return 2;
      return result.ok ? 0 : 1;
    }
    if (command === "drain") {
      const flags = parseFlags(rest);
      const tokenEnv = typeof flags["token-env"] === "string" ? flags["token-env"] : "SLACK_BOT_TOKEN";
      const statePath = typeof flags.state === "string" ? flags.state : "slack-breaker-state.json";
      const outboxPath = typeof flags.outbox === "string" ? flags.outbox : "slack-breaker-outbox.json";
      const max = typeof flags.max === "string" ? Number(flags.max) : 100;
      const engine = buildEngine(tokenFrom(tokenEnv), statePath, outboxPath);
      const report = await engine.drain(Number.isFinite(max) && max > 0 ? max : 100);
      if (flags.json === true) {
        io.out(JSON.stringify(report, null, 2));
      } else {
        io.out(`drained=${report.drained} deferred=${report.deferred} remaining=${report.remaining} reason=${report.stoppedReason}`);
      }
      return report.remaining === 0 ? 0 : 2;
    }
    io.err(`unknown command: ${command}

${USAGE}`);
    return 1;
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
function main(argv = process.argv.slice(2)) {
  runCli(argv, { out: (s) => console.log(s), err: (s) => console.error(s) }).then((code) => {
    if (code !== 0)
      process.exit(code);
  });
}
if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  main();
}
function basename(p) {
  const parts = p.split("/");
  return parts[parts.length - 1];
}
export {
  main,
  runCli
};
