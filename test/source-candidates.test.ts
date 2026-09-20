import { describe, expect, it } from "vitest";

async function loadCandidates(): Promise<typeof import("../src/lib/tracer/source-candidates") | null> {
  try {
    return await import("../src/lib/tracer/source-candidates");
  } catch {
    return null;
  }
}

describe("source candidate ranking", () => {
  it("marks a canonical same-page URL as page context", async () => {
    const module = await loadCandidates();
    const classify = (module as unknown as {
      classifySourceContext?: (fetchedUrl: string, inspectedUrl: string) => string[];
    } | null)?.classifySourceContext;

    expect(classify).toBeTypeOf("function");
    expect(classify?.("https://example.test/article?utm_source=search", "https://example.test/article#claim")).toEqual(["page_context"]);
  });

  it("marks The Onion as non-factual context", async () => {
    const module = await loadCandidates();
    const classify = (module as unknown as {
      classifySourceContext?: (fetchedUrl: string, inspectedUrl: string) => string[];
    } | null)?.classifySourceContext;

    expect(classify).toBeTypeOf("function");
    expect(classify?.("https://theonion.com/story", "https://reader.test/article")).toEqual(["non_factual_context"]);
  });

  it("marks an ordinary external domain as credibility unassessed", async () => {
    const module = await loadCandidates();
    const sourceQuality = (module as unknown as {
      sourceQuality?: (url: string) => string;
    } | null)?.sourceQuality;

    expect(sourceQuality).toBeTypeOf("function");
    expect(sourceQuality?.("https://example.net/report")).toBe("credibility_unassessed");
  });

  it("provides the candidate ranking module", async () => {
    expect(await loadCandidates()).not.toBeNull();
  });

  it("keeps a government primary result ahead of a news result and canonicalizes URLs", async () => {
    const module = await loadCandidates();
    expect(module).not.toBeNull();

    const results = module?.rankCandidates([
      { url: "https://news.test/story?utm_source=x", title: "Coverage", description: "Revenue grew" },
      { url: "https://data.gov/release#summary", title: "Official release", description: "Revenue grew" },
    ]);

    expect(results?.map((result) => result.url)).toEqual(["https://data.gov/release", "https://news.test/story"]);
  });

  it("drops non-HTTPS URLs, duplicate canonical URLs, and candidates after the fifth", async () => {
    const module = await loadCandidates();
    expect(module).not.toBeNull();

    const results = module?.rankCandidates([
      { url: "http://bad.test", title: "Bad", description: "" },
      { url: "https://example.test/a?utm_medium=x", title: "First", description: "" },
      { url: "https://example.test/a#duplicate", title: "Duplicate", description: "" },
      { url: "https://one.test", title: "One", description: "" },
      { url: "https://two.test", title: "Two", description: "" },
      { url: "https://three.test", title: "Three", description: "" },
      { url: "https://four.test", title: "Four", description: "" },
      { url: "https://five.test", title: "Five", description: "" },
    ]);

    expect(results).toHaveLength(5);
    expect(results?.some((result) => result.url === "http://bad.test")).toBe(false);
    expect(results?.filter((result) => result.url === "https://example.test/a")).toHaveLength(1);
  });
});
