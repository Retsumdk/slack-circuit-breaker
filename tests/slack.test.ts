import { describe, expect, test } from "bun:test";
import { SlackApiError, SlackClient, backoffDelay, classify } from "../src/slack.js";
import type { FetchLike } from "../src/slack.js";
import type { Clock } from "../src/types.js";

function okClock(): Clock {
  return { now: () => 0, sleep: () => Promise.resolve() };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function clientWith(fetchImpl: FetchLike): SlackClient {
  return new SlackClient("xoxb-test-token", { fetchImpl, clock: okClock() });
}

describe("SlackClient", () => {
  test("posts JSON with bearer auth to the method URL", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const client = clientWith(async (url, init) => {
      captured = { url, init };
      return jsonResponse(200, { ok: true, ts: "1.0" });
    });
    const result = await client.call("chat.postMessage", { channel: "C1", text: "hi" });
    expect(result.ok).toBe(true);
    expect(captured!.url).toBe("https://slack.com/api/chat.postMessage");
    const headers = new Headers(captured!.init.headers as Record<string, string>);
    expect(headers.get("authorization")).toBe("Bearer xoxb-test-token");
    expect(headers.get("content-type")).toContain("application/json");
    expect(captured!.init.body).toBe(JSON.stringify({ channel: "C1", text: "hi" }));
  });

  test("network failure throws a network-kind error", async () => {
    const client = clientWith(async () => {
      throw new TypeError("fetch failed");
    });
    try {
      await client.call("chat.postMessage");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SlackApiError);
      expect((err as SlackApiError).kind).toBe("network");
    }
  });

  test("429 becomes rate-limited and parses Retry-After", async () => {
    const client = clientWith(async () => jsonResponse(429, { ok: false }, { "retry-after": "30" }));
    const err = await client.call("chat.postMessage").catch((e) => e as SlackApiError);
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err.kind).toBe("rate-limited");
    expect(err.retryAfterSec).toBe(30);
  });

  test("429 without Retry-After header is still rate-limited", async () => {
    const client = clientWith(async () => jsonResponse(429, { ok: false }));
    const err = await client.call("chat.postMessage").catch((e) => e as SlackApiError);
    expect(err.kind).toBe("rate-limited");
    expect(err.retryAfterSec).toBeUndefined();
  });

  test("5xx becomes server-kind", async () => {
    const client = clientWith(async () => jsonResponse(503, { ok: false }));
    const err = await client.call("chat.postMessage").catch((e) => e as SlackApiError);
    expect(err.kind).toBe("server");
  });

  test("4xx non-429 becomes permanent-kind", async () => {
    const client = clientWith(async () => jsonResponse(404, { ok: false }));
    const err = await client.call("chat.postMessage").catch((e) => e as SlackApiError);
    expect(err.kind).toBe("permanent");
  });

  test("ok:false with a permanent code is permanent", async () => {
    const client = clientWith(async () => jsonResponse(200, { ok: false, error: "channel_not_found" }));
    const err = await client.call("chat.postMessage").catch((e) => e as SlackApiError);
    expect(err.kind).toBe("permanent");
    expect(err.code).toBe("channel_not_found");
  });

  test("ok:false with a retryable code (e.g. rate_limited body) is server-kind", async () => {
    const client = clientWith(async () => jsonResponse(200, { ok: false, error: "internal_error" }));
    const err = await client.call("chat.postMessage").catch((e) => e as SlackApiError);
    expect(err.kind).toBe("server");
    expect(err.code).toBe("internal_error");
  });

  test("non-JSON body becomes server-kind", async () => {
    const client = clientWith(async () => new Response("<html>", { status: 200 }));
    const err = await client.call("chat.postMessage").catch((e) => e as SlackApiError);
    expect(err.kind).toBe("server");
  });

  test("baseUrl can be overridden", async () => {
    let url = "";
    const client = new SlackClient("t", {
      baseUrl: "https://slack.local/api",
      fetchImpl: async (u) => {
        url = u;
        return jsonResponse(200, { ok: true });
      },
      clock: okClock(),
    });
    await client.call("chat.postMessage");
    expect(url).toBe("https://slack.local/api/chat.postMessage");
  });
});

describe("classify", () => {
  test("permanent codes", () => {
    for (const code of ["invalid_auth", "token_revoked", "channel_not_found", "msg_too_long", "is_archived"]) {
      expect(classify(code)).toBe("permanent");
    }
  });
  test("rate_limited is rate-limited", () => {
    expect(classify("rate_limited")).toBe("rate-limited");
  });
  test("unknown codes default to server", () => {
    expect(classify("fatal_error")).toBe("server");
    expect(classify("something_new")).toBe("server");
  });
});

describe("backoffDelay", () => {
  test("full jitter stays in [0, base * 2^attempt]", () => {
    for (const random of [0, 0.25, 0.999]) {
      for (const attempt of [0, 1, 2, 5]) {
        const d = backoffDelay(100, attempt, () => random);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(Math.floor(random * 100 * 2 ** attempt));
      }
    }
  });
  test("zero-random is deterministic zero", () => {
    expect(backoffDelay(500, 3, () => 0)).toBe(0);
  });
});
