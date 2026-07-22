import { describe, test, expect } from "bun:test";
describe("slack-circuit-breaker", () => {
  test("module loads", async () => { const m = await import("./index"); expect(m).toBeDefined(); });
});
