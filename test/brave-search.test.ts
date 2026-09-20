import { afterEach, describe, expect, it } from "vitest";

const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = nativeFetch;
});

async function loadBraveSearch(): Promise<typeof import("../src/lib/tracer/brave-search") | null> {
  try {
    return await import("../src/lib/tracer/brave-search");
  } catch {
    return null;
  }
}

describe("searchQuery", () => {
  it("quotes the verified text after the claim", async () => {
    const module = await loadBraveSearch();
    expect(module!.searchQuery("Revenue rose.", "revenue  increased")).toBe('Revenue rose. "revenue increased"');
    expect(module!.searchQuery("", "revenue increased")).toBe('"revenue increased"');
  });

  it("keeps the query inside Brave's 400 character and 50 word limits, trimming the claim first", async () => {
    const module = await loadBraveSearch();
    const claim = Array.from({ length: 40 }, (_, i) => `claim${i}`).join(" ");
    const quote = Array.from({ length: 30 }, (_, i) => `quote${i}`).join(" ");

    const query = module!.searchQuery(claim, quote);

    expect(query.split(/\s+/)).toHaveLength(50);
    expect(query).toContain(`"${quote}"`);
    expect(query.startsWith("claim0 ")).toBe(true);

    const wholeQuote = module!.searchQuery("w".repeat(300), `${"q".repeat(300)} tail`);
    expect(wholeQuote).toBe(`"${"q".repeat(300)} tail"`);

    const oversizedQuote = module!.searchQuery("claim", Array.from({ length: 45 }, () => "wordsword9").join(" "));
    expect(oversizedQuote.length).toBeLessThanOrEqual(400);
    expect(oversizedQuote).toMatch(/^"(wordsword9 )+wordsword9"$/);
  });
});

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
