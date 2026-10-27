# slack-circuit-breaker

A circuit breaker for the [Slack Web API](https://api.slack.com/web) — retry with backoff, a persistent fallback outbox, and drain-on-recovery. Zero runtime dependencies.

## The problem

Slack rate limits aggressively (tiered per-method budgets plus 429 `Retry-After` responses), and it has real incidents — 5xx storms, connection resets, brownouts. Code that calls `chat.postMessage` in a loop during an outage does three bad things at once:

1. **It hammers a struggling API** — retry storms make recovery slower and can escalate your workspace toward longer rate-limit windows.
2. **It loses messages** — a post that fails during an incident is usually a notification someone needed, and it just evaporates.
3. **It has no memory across restarts** — a process that crashes and restarts mid-outage immediately re-admits traffic to the failing API because its failure history lived in RAM.

Generic HTTP circuit breakers (e.g. opossum) handle the tripping part, but they are transport-agnostic: they don't understand Slack's `Retry-After` semantics, they can't distinguish a permanent rejection like `channel_not_found` (which should never count as an outage) from a 5xx (which should), and they don't park the actual payloads so they can be replayed after recovery.

## How this solves it

**slack-circuit-breaker** is a Slack-specific breaker built from four cooperating pieces:

```
send(method, body)
      │
      ▼
┌──────────────┐   allowed?   ┌─────────────┐
│ CircuitBreaker├─────────────►│ BreakerClient│──► SlackClient ──► slack.com/api
│ (state + window)│            │ (retry/backoff)│        │
└──────────────┘              └─────────────┘        │
      ▲  │                                            ▼
      │  │ refused            ┌──────────────────────┴──────┐
      │  └───────────────────►│ Outbox (persistent queue)    │
      │                       └─────────────────────────────┘
      │                                     │
      └──────── drain() on recovery ────────┘
```

- **`CircuitBreaker`** — closed / open / half-open state machine. A sliding window (`windowSize` samples) computes the failure rate and trips at `failureRateThreshold` once `minimumThroughput` samples exist; `consecutiveFailureThreshold` fast-trips on a hard outage. After `cooldownMs` open, exactly one half-open probe call is admitted (concurrent callers are refused, a probe never survives a restart). Recovery requires `halfOpenSuccessThreshold` probe successes.
- **`SlackClient`** — the Web API transport. It classifies every failure: HTTP 429 honors the `Retry-After` header (`rate-limited`), 5xx and network errors are transport failures (`server` / `network`), and Slack's documented permanent error codes (`channel_not_found`, `invalid_auth`, `msg_too_long`, …) are `permanent`. Only transport-class failures are retried and only they feed the breaker — a bad channel ID should page a human, not trip a circuit.
- **`BreakerClient`** — retry with exponential backoff and full jitter around the breaker. A call that exhausts its retries reports the last failure; a call the breaker refuses reports `kind: "circuit-open"` without touching the network.
- **`Outbox` + `SlackBreaker`** — when the circuit refuses a call, the request is parked (with deterministic ids and attempt counters) in a JSON outbox with atomic writes. `drain()` replays it oldest-first once the circuit closes, deferring (rotating) a message that fails transiently so one poison entry cannot starve the queue. Breaker state is persisted (`saveBreakerState`) with the same care, so a restart during an outage does not instantly re-admit traffic — an expired cooldown still forces the half-open probe path.

## Installation

```bash
npm install github:Retsumdk/slack-circuit-breaker
```

Or with Bun (Bun blocks git-dependency lifecycle scripts by default, so trust the package after adding):

```bash
bun add github:Retsumdk/slack-circuit-breaker
bun pm trust slack-circuit-breaker
```

Or clone and build:

```bash
git clone https://github.com/Retsumdk/slack-circuit-breaker.git
cd slack-circuit-breaker
bun install
bun run build
```

## Quick start (library)

```ts
import { CircuitBreaker, SlackBreaker } from "slack-circuit-breaker";

const engine = SlackBreaker.inMemory(process.env.SLACK_BOT_TOKEN!, {
  breaker: new CircuitBreaker({ consecutiveFailureThreshold: 5, cooldownMs: 30_000 }),
});

const result = await engine.send("chat.postMessage", { channel: "C123", text: "deploy done" });
if (result.sent) {
  console.log("delivered");
} else if (result.queued) {
  console.log(`circuit open — parked as ${result.messageId}`);
} else {
  console.log(`Slack rejected it permanently: ${result.code}`);
}

// Later, e.g. on a timer: replay parked messages once Slack recovers.
const report = await engine.drain();
console.log(`drained=${report.drained} remaining=${report.remaining} reason=${report.stoppedReason}`);
```

For a process that restarts, wire persistence:

```ts
import { CircuitBreaker, BreakerClient, SlackBreaker, SlackClient, loadBreakerState, loadOutbox } from "slack-circuit-breaker";

const breaker = new CircuitBreaker({ consecutiveFailureThreshold: 5, cooldownMs: 30_000 });
loadBreakerState("slack-breaker-state.json", breaker); // no-op if the file does not exist yet
const outbox = loadOutbox("slack-breaker-outbox.json");
const engine = new SlackBreaker(
  new BreakerClient(new SlackClient(process.env.SLACK_BOT_TOKEN!), breaker),
  outbox,
  { statePath: "slack-breaker-state.json" }
);
```

## Quick start (CLI)

The `scb` CLI drives the same engine — the demo needs no token and no network:

```bash
npx github:Retsumdk/slack-circuit-breaker demo
```

```text
slack-circuit-breaker demo — scripted Slack: 2x network fail, 1x 429, then healthy

send #1 (2 network failures + 429)            ok=false code=rate_limited attempts=3 waited=0ms
breaker after send #1                         state=open window=3 failureRate=100%
send #2 (circuit now open)                    sent=false queued=true id=1-1700000000000
breaker after send #2                         state=open window=3 failureRate=100%
send #3 (parked again)                        queued=true outbox=2

cooldown elapses (clock +60s) — next send becomes the half-open probe
send #4 (half-open probe)                     ok=true state=closed
drain outbox                                  drained=2 remaining=0 reason=empty
final breaker state                           state=closed window=2 failureRate=0%
```

Real traffic:

```bash
export SLACK_BOT_TOKEN=xoxb-...
scb send chat.postMessage --channel C123 --text "deploy done"          # exit 0 sent, 2 parked, 1 rejected
scb status                                                             # breaker state + outbox size
scb drain                                                              # replay parked messages
scb send chat.postMessage --channel C123 --text hi --json              # machine-readable result
```

Exit codes: `0` ok · `1` error (bad usage, no token, permanent rejection) · `2` circuit open / outbox not fully drained.

## Configuration

`CircuitBreaker` options (defaults shown):

```ts
{
  windowSize: 20,                  // sliding window samples for the failure rate
  minimumThroughput: 5,            // samples required before the rate can trip
  failureRateThreshold: 0.5,       // trip at ≥50% failures in the window
  consecutiveFailureThreshold: 5,  // hard-outage fast trip
  cooldownMs: 30_000,              // open → half-open delay
  halfOpenSuccessThreshold: 2,     // probe successes required to close
  clock?: Clock,                   // inject for deterministic tests
}
```

`BreakerClient` retry policy: `{ maxRetries: 3, baseDelayMs: 500, random }` — delay is `Retry-After` seconds for 429s, otherwise exponential backoff with full jitter. Inject `clock` and a seeded `random` for fully deterministic tests.

## Development

```bash
bun install
bun run typecheck          # src, strict + declaration
bun run typecheck:tests    # src + tests
bun test                   # 70 tests across 6 suites
bun run build              # tsc → dist/
node dist/cli.js demo      # deterministic walkthrough (CI diffs two runs)
```

## License

MIT — see [LICENSE](LICENSE).