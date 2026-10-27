/**
 * slack-circuit-breaker — a circuit breaker for the Slack Web API with
 * retry/backoff, a persistent fallback outbox, and drain-on-recovery.
 *
 * Library surface:
 * - `CircuitBreaker` — state machine (closed / open / half-open) with a
 *   sliding failure-rate window and a consecutive-failure fast trip.
 * - `SlackClient` — Web API transport: 429 Retry-After, 5xx, network errors,
 *   and permanent Slack rejections are classified for the breaker.
 * - `BreakerClient` — retry with exponential backoff + full jitter, wrapped
 *   in the breaker; only transport-class failures count.
 * - `SlackBreaker` — facade with a persistent outbox: calls refused by the
 *   open circuit are parked and replayed by `drain()` after recovery.
 * - `saveBreakerState` / `loadBreakerState` — survive restarts without
 *   re-admitting traffic to a failing Slack.
 */
export { CircuitBreaker, DEFAULT_OPTIONS } from "./circuit.js";
export type { CircuitOptions, CircuitSnapshot, CircuitState } from "./circuit.js";
export { SlackApiError, SlackClient, SLACK_API_BASE, backoffDelay, classify } from "./slack.js";
export type { FailureKind, FetchLike } from "./slack.js";
export { BreakerClient, DEFAULT_RETRY_POLICY } from "./breaker-client.js";
export type { CallFailureKind, CallOutcome, RetryPolicy } from "./breaker-client.js";
export { SlackBreaker } from "./engine.js";
export type { DrainReport, SendResult } from "./engine.js";
export { Outbox, loadOutbox } from "./outbox.js";
export type { OutboxMessage } from "./outbox.js";
export { breakerSummary, loadBreakerState, saveBreakerState } from "./state.js";
export { systemClock } from "./types.js";
export type { Clock, Sample } from "./types.js";
