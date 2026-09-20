export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface RateLimitWindow {
  startedAt: number;
  count: number;
}

export type RateLimitDecision = { allowed: true; window: RateLimitWindow } | { allowed: false; retryAfterSeconds: number };

/**
 * Thirty traces in ten minutes is three pages of ten claims each. It stops a runaway client or a
 * leaked URL with one install id from draining the search and browser budget; it is not a defence
 * against a caller that rotates install ids, which needs an edge limit keyed by IP.
 */
export const DEFAULT_RATE_LIMIT: RateLimitPolicy = { limit: 30, windowMs: 10 * 60 * 1000 };

/** A fixed window: one small record per install, and a refused caller learns exactly when to retry. */
export function takeRateLimitToken(window: RateLimitWindow | undefined, now: number, policy: RateLimitPolicy): RateLimitDecision {
  const current = window && now - window.startedAt < policy.windowMs ? window : { startedAt: now, count: 0 };
  if (current.count >= policy.limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.startedAt + policy.windowMs - now) / 1000)) };
  }
  return { allowed: true, window: { startedAt: current.startedAt, count: current.count + 1 } };
}

export function rateLimitPolicy(env: { TRACE_RATE_LIMIT?: string; TRACE_RATE_WINDOW_SECONDS?: string }): RateLimitPolicy {
  const limit = Number(env.TRACE_RATE_LIMIT);
  const seconds = Number(env.TRACE_RATE_WINDOW_SECONDS);
  return {
    limit: Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_RATE_LIMIT.limit,
    windowMs: Number.isInteger(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RATE_LIMIT.windowMs,
  };
}
