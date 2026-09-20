import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_RATE_LIMIT } from "../src/rate-limit";
import type { Env } from "../src/types";

const bindings = env as unknown as Env;

function trace(installId: string, body: string): Promise<Response> {
  const stub = bindings.SOURCE_TRACER.get(bindings.SOURCE_TRACER.idFromName(installId));
  return stub.fetch("https://worker.test/v1/trace", { method: "POST", headers: { "content-type": "application/json" }, body });
}

const valid = JSON.stringify({
  claim: "Revenue rose.",
  verifiedQuote: "revenue increased",
  page: { url: "https://example.test", title: "Example" },
  installId: "install-limited",
});

describe("SourceTracerAgent", () => {
  it("answers 429 with Retry-After once an install has spent its window", async () => {
    const stub = bindings.SOURCE_TRACER.get(bindings.SOURCE_TRACER.idFromName("install-limited"));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("rateLimit", { startedAt: Date.now(), count: DEFAULT_RATE_LIMIT.limit });
    });

    const response = await trace("install-limited", valid);

    expect(response.status).toBe(429);
    const retryAfter = Number(response.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(DEFAULT_RATE_LIMIT.windowMs / 1000);
    await expect(response.json()).resolves.toEqual({ error: "Too many source traces from this install." });
  });

  it("validates the body itself and does not charge the window for a refused request", async () => {
    const response = await trace("install-invalid", JSON.stringify({ installId: "install-invalid" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "verifiedQuote is required." });
    const stub = bindings.SOURCE_TRACER.get(bindings.SOURCE_TRACER.idFromName("install-invalid"));
    await expect(runInDurableObject(stub, (_instance, state) => state.storage.get("rateLimit"))).resolves.toBeUndefined();
  });
});
