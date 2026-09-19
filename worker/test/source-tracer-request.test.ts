import { describe, expect, it } from "vitest";

async function loadWorker(): Promise<{ default?: { fetch?: (request: Request) => Promise<Response> } } | null> {
  try {
    return await import("../src/index");
  } catch {
    return null;
  }
}

describe("POST /v1/trace", () => {
  it("provides the source tracer worker", async () => {
    expect(await loadWorker()).not.toBeNull();
  });

  it("rejects a request with no claim quote", async () => {
    const module = await loadWorker();
    expect(module).not.toBeNull();

    const response = await module?.default?.fetch?.(
      new Request("https://worker.test/v1/trace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim: "Revenue rose", page: { url: "https://example.test", title: "Example" } }),
      }),
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ error: "verifiedQuote is required." });
  });

  it("rejects invalid JSON", async () => {
    const module = await loadWorker();
    expect(module).not.toBeNull();

    const response = await module?.default?.fetch?.(
      new Request("https://worker.test/v1/trace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ error: "Invalid JSON." });
  });
});
