import { BreakerClient, CallOutcome } from "./breaker-client.js";
import { CircuitBreaker, CircuitSnapshot } from "./circuit.js";
import { SlackBreaker } from "./engine.js";
import { loadOutbox, Outbox } from "./outbox.js";
import { SlackClient } from "./slack.js";
import { breakerSummary, loadBreakerState } from "./state.js";
import { Clock, systemClock } from "./types.js";

const USAGE = `scb — Slack circuit breaker

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

interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
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

function requireString(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required --${name}`);
  }
  return v;
}

function tokenFrom(envName: string): string {
  const token = process.env[envName];
  if (!token || token.length === 0) {
    throw new Error(`no token: set ${envName} in the environment`);
  }
  return token;
}

function buildEngine(
  token: string,
  statePath: string | null,
  outboxPath: string | null,
  clock: Clock = systemClock
): SlackBreaker {
  const breaker = new CircuitBreaker({ clock });
  if (statePath !== null) loadBreakerState(statePath, breaker);
  const outbox = outboxPath !== null ? loadOutbox(outboxPath) : new Outbox(null);
  const slack = new SlackClient(token, { clock });
  return new SlackBreaker(new BreakerClient(slack, breaker), outbox, { clock, statePath });
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command = "", ...rest] = argv;
  try {
    if (command === "help" || command === "--help" || command === "") {
      io.out(USAGE);
      return command === "" && rest.length === 0 ? 1 : 0;
    }
    if (command === "demo") {
      const { runDemo } = await import("./demo.js");
      await runDemo(io.out);
      return 0;
    }
    if (command === "status") {
      const flags = parseFlags(rest);
      const statePath = typeof flags.state === "string" ? flags.state : "slack-breaker-state.json";
      const outboxPath = typeof flags.outbox === "string" ? flags.outbox : "slack-breaker-outbox.json";
      const breaker = new CircuitBreaker();
      if (statePath !== null) loadBreakerState(statePath, breaker);
      const snap: CircuitSnapshot = breaker.snapshot();
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
      const positional = rest.filter((a) => !a.startsWith("--") && a !== (flags.channel as string) && a !== (flags.text as string));
      const method = positional[0];
      if (!method) throw new Error("usage: scb send <method> [flags]");
      const tokenEnv = typeof flags["token-env"] === "string" ? flags["token-env"] : "SLACK_BOT_TOKEN";
      const statePath = typeof flags.state === "string" ? flags.state : "slack-breaker-state.json";
      const outboxPath = typeof flags.outbox === "string" ? flags.outbox : "slack-breaker-outbox.json";
      const body: Record<string, unknown> = {};
      if (typeof flags.channel === "string") body.channel = flags.channel;
      if (typeof flags.text === "string") body.text = flags.text;
      const engine = buildEngine(tokenFrom(tokenEnv), statePath, outboxPath);
      const result = await engine.send(method, body);
      if (flags.json === true) {
        io.out(JSON.stringify({ ...result, outcome: { ...result.outcome, kind: result.outcome.kind ?? null, code: result.outcome.code ?? null } }, null, 2));
      } else {
        io.out(`method=${method} sent=${result.sent} queued=${result.queued} code=${result.code ?? "ok"}`);
      }
      if (result.queued) return 2;
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
    io.err(`unknown command: ${command}\n\n${USAGE}`);
    return 1;
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export function main(argv: string[] = process.argv.slice(2)): void {
  void runCli(argv, { out: (s) => console.log(s), err: (s) => console.error(s) }).then((code) => {
    if (code !== 0) process.exit(code);
  });
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  main();
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1]!;
}

export type { CallOutcome };
