import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { dirname } from "path";

export interface OutboxMessage {
  id: string;
  method: string;
  body: Record<string, unknown>;
  enqueuedAt: number;
  attempts: number;
}

const OUTBOX_FORMAT = "slack-circuit-breaker/outbox";

interface OutboxFile {
  format: string;
  version: number;
  messages: OutboxMessage[];
}

export class Outbox {
  private messages: OutboxMessage[] = [];
  private nextId = 1;
  constructor(readonly path: string | null) {}

  /** Deterministic ids: <seq>-<enqueuedAt>. */
  enqueue(method: string, body: Record<string, unknown>, at: number): OutboxMessage {
    const msg: OutboxMessage = { id: `${this.nextId++}-${at}`, method, body, enqueuedAt: at, attempts: 0 };
    this.messages.push(msg);
    this.persist();
    return msg;
  }

  peek(): OutboxMessage | undefined {
    return this.messages[0];
  }

  /** Count attempts and rotate to the back so one poison message cannot starve the queue. */
  defer(msg: OutboxMessage): void {
    msg.attempts += 1;
    this.messages = this.messages.filter((m) => m.id !== msg.id);
    this.messages.push(msg);
    this.persist();
  }

  dequeue(msg: OutboxMessage): void {
    this.messages = this.messages.filter((m) => m.id !== msg.id);
    this.persist();
  }

  get size(): number {
    return this.messages.length;
  }

  all(): readonly OutboxMessage[] {
    return this.messages;
  }

  /** Load a persisted outbox; a missing file yields an empty outbox. */
  static load(path: string): Outbox {
    if (!existsSync(path)) return new Outbox(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
    } catch (err) {
      throw new Error(`corrupt outbox file ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const file = parsed as OutboxFile | null;
    if (!file || file.format !== OUTBOX_FORMAT || file.version !== 1 || !Array.isArray(file.messages)) {
      throw new Error(`unrecognized outbox format in ${path}`);
    }
    const outbox = new Outbox(path);
    for (const raw of file.messages) {
      const msg = raw as Partial<OutboxMessage> | null;
      if (
        typeof msg?.id !== "string" ||
        typeof msg.method !== "string" ||
        typeof msg.body !== "object" ||
        msg.body === null
      ) {
        throw new Error(`corrupt outbox message in ${path}`);
      }
      const restored: OutboxMessage = { id: msg.id, method: msg.method, body: msg.body, enqueuedAt: typeof msg.enqueuedAt === "number" ? msg.enqueuedAt : 0, attempts: typeof msg.attempts === "number" ? msg.attempts : 0 };
      outbox.messages.push(restored);
      const seq = Number(restored.id.split("-")[0]);
      if (Number.isFinite(seq) && seq >= outbox.nextId) outbox.nextId = seq + 1;
    }
    return outbox;
  }

  private persist(): void {
    if (this.path === null) return;
    const file: OutboxFile = { format: OUTBOX_FORMAT, version: 1, messages: this.messages };
    const tmp = `${this.path}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(file, null, 2));
    renameSync(tmp, this.path);
  }
}

export function loadOutbox(path: string): Outbox {
  return Outbox.load(path);
}
