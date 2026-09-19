import { afterEach, describe, expect, it } from "vitest";

const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = nativeFetch;
});

async function loadBraveSearch(): Promise<typeof import("../src/brave-search") | null> {
  try {
    return await import("../src/brave-search");
  } catch {
    return null;
  }
}

describe("BraveSearchClient", () => {
  it("calls the Worker fetch function with globalThis as its receiver", async () => {
    const module = await loadBraveSearch();
    expect(module).not.toBeNull();
    let receiver: unknown;
    globalThis.fetch = async function (this: unknown) {
      receiver = this;
      return Response.json({ web: { results: [] } });
    };

    await new module!.BraveSearchClient("token").search("revenue rose");

    expect(receiver).toBe(globalThis);
  });

  it("maps web results and sends the subscription token", async () => {
    const module = await loadBraveSearch();
    expect(module).not.toBeNull();
    const calls: Request[] = [];
    const client = new module!.BraveSearchClient("token", async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ web: { results: [{ url: "https://data.gov/release", title: "Release", description: "Details" }] } });
    });

    await expect(client.search("revenue rose")).resolves.toEqual([
      { url: "https://data.gov/release", title: "Release", description: "Details" },
    ]);
    expect(calls[0].headers.get("X-Subscription-Token")).toBe("token");
    expect(calls[0].url).toContain("q=revenue+rose");
  });

  it("throws SearchUnavailableError when Brave rejects the request", async () => {
    const module = await loadBraveSearch();
    expect(module).not.toBeNull();
    const client = new module!.BraveSearchClient("token", async () => new Response("rate limited", { status: 429 }));

    await expect(client.search("revenue rose")).rejects.toBeInstanceOf(module!.SearchUnavailableError);
  });
});
