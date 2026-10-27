import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { dirname } from "path";
import { CircuitBreaker, CircuitSnapshot } from "./circuit.js";

const STATE_FORMAT = "slack-circuit-breaker/state";

interface BreakerStateFile {
  format: string;
  version: number;
  breaker: {
    state: CircuitSnapshot["state"];
    consecutiveFailures: number;
    openUntil: number;
    halfOpenSuccesses: number;
  };
  updatedAt: number;
}

export function saveBreakerState(path: string, breaker: CircuitBreaker, updatedAt: number): void {
  const snap = breaker.snapshot();
  const file: BreakerStateFile = {
    format: STATE_FORMAT,
    version: 1,
    breaker: {
      state: snap.state,
      consecutiveFailures: snap.consecutiveFailures,
      openUntil: snap.openUntil,
      halfOpenSuccesses: snap.halfOpenSuccesses,
    },
    updatedAt,
  };
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, path);
}

export function loadBreakerState(path: string, breaker: CircuitBreaker): void {
  if (!existsSync(path)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`corrupt state file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const file = parsed as BreakerStateFile | null;
  if (!file || file.format !== STATE_FORMAT || file.version !== 1) {
    throw new Error(`unrecognized breaker state format in ${path}`);
  }
  breaker.restore(file.breaker);
}

export function breakerSummary(snap: CircuitSnapshot): string {
  const rate = snap.failureRate === null ? "n/a" : `${Math.round(snap.failureRate * 100)}%`;
  return `state=${snap.state} window=${snap.windowSamples} failureRate=${rate} calls=${snap.totalCalls} failures=${snap.totalFailures}`;
}
