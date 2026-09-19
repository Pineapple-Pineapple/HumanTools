import { describe, expect, it } from "vitest";
import type { Env } from "../src/types";

async function loadWorker(): Promise<typeof import("../src/index") | null> {
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

    const response = await module?.default.fetch(
      new Request("https://worker.test/v1/trace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim: "Revenue rose", page: { url: "https://example.test", title: "Example" } }),
      }),
      {} as Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ error: "verifiedQuote is required." });
  });

  it("rejects invalid JSON", async () => {
    const module = await loadWorker();
    expect(module).not.toBeNull();

    const response = await module?.default.fetch(
      new Request("https://worker.test/v1/trace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
      {} as Env,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ error: "Invalid JSON." });
  });

  it("forwards a valid request to the install's source tracer agent", async () => {
    const module = await loadWorker();
    expect(module).not.toBeNull();
    const idNames: string[] = [];
    const forwarded: Request[] = [];
    const response = await module?.default.fetch(
      new Request("https://worker.test/v1/trace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claim: "Revenue rose.",
          verifiedQuote: "revenue increased",
          page: { url: "https://example.test", title: "Example" },
          installId: "install-1",
        }),
      }),
      {
        SOURCE_TRACER: {
          idFromName: (name: string) => {
            idNames.push(name);
            return "agent-id";
          },
          get: () => ({
            fetch: async (request: Request) => {
              forwarded.push(request);
              return Response.json({ type: "SOURCE_TRACE_DONE", sources: [] });
            },
          }),
        },
      } as unknown as Env,
    );

    expect(response?.status).toBe(200);
    expect(idNames).toEqual(["install-1"]);
    expect(forwarded).toHaveLength(1);
  });
});
