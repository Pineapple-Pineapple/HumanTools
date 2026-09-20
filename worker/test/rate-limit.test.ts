import { describe, expect, it } from "vitest";
import { DEFAULT_RATE_LIMIT, rateLimitPolicy, takeRateLimitToken } from "../src/rate-limit";

const policy = { limit: 3, windowMs: 60_000 };

describe("takeRateLimitToken", () => {
  it("allows up to the limit within a window, then refuses with the seconds left", () => {
    let window = undefined as ReturnType<typeof takeRateLimitToken> extends infer D ? (D extends { window: infer W } ? W : never) | undefined : never;
    for (let i = 0; i < policy.limit; i++) {
      const decision = takeRateLimitToken(window, 1_000 + i, policy);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) window = decision.window;
    }
    expect(window).toEqual({ startedAt: 1_000, count: 3 });

    const refused = takeRateLimitToken(window, 31_000, policy);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 30 });
  });

  it("opens a fresh window once the old one has elapsed", () => {
    const decision = takeRateLimitToken({ startedAt: 1_000, count: 3 }, 61_000, policy);
    expect(decision).toEqual({ allowed: true, window: { startedAt: 61_000, count: 1 } });
  });

  it("never asks a refused caller to wait less than a second", () => {
    const decision = takeRateLimitToken({ startedAt: 1_000, count: 3 }, 60_999, policy);
    expect(decision).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});

describe("rateLimitPolicy", () => {
  it("uses the defaults unless the vars are positive integers", () => {
    expect(rateLimitPolicy({})).toEqual(DEFAULT_RATE_LIMIT);
    expect(rateLimitPolicy({ TRACE_RATE_LIMIT: "0", TRACE_RATE_WINDOW_SECONDS: "abc" })).toEqual(DEFAULT_RATE_LIMIT);
    expect(rateLimitPolicy({ TRACE_RATE_LIMIT: "5", TRACE_RATE_WINDOW_SECONDS: "60" })).toEqual({ limit: 5, windowMs: 60_000 });
  });
});
