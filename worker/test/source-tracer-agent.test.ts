import { describe, expect, it } from "vitest";
import type { CandidateSource } from "../src/source-candidates";

async function loadTracer(): Promise<typeof import("../src/source-tracer-agent") | null> {
  try {
    return await import("../src/source-tracer-agent");
  } catch {
    return null;
  }
}

const matchingCandidate: CandidateSource = {
  url: "https://data.gov/release",
  title: "Official release",
  description: "",
  domainScore: 300,
};
const nonMatchingCandidate: CandidateSource = {
  url: "https://news.test/coverage",
  title: "Coverage",
  description: "",
  domainScore: 0,
};

const traceRequest = {
  claim: "Revenue rose substantially.",
  verifiedQuote: "revenue increased from $1 million to $4 million",
  page: { url: "https://page.test/article", title: "Article" },
  installId: "install-1",
};

describe("source tracer", () => {
  it("keeps a same-page exact match as context instead of verified evidence", async () => {
    const module = await loadTracer();
    expect(module).not.toBeNull();
    const tracer = module!.makeSourceTracer({
      search: async () => [matchingCandidate],
      fetch: async () => ({
        title: "Inspected article",
        url: "https://page.test/article?utm_source=search",
        text: "Revenue increased from $1 million to $4 million in 2025.",
      }),
    });

    const outcome = await tracer.trace({
      ...traceRequest,
      page: { url: "https://page.test/article#selected", title: "Article" },
    });

    expect(outcome.sources).toEqual([]);
    expect(outcome.contexts).toEqual([expect.objectContaining({ contextReasons: ["page_context"] })]);
    expect(outcome.trace).toContainEqual(
      expect.objectContaining({ step: "Source verifier", state: "skipped", detail: "Page context only." }),
    );
  });

  it("returns only sources whose fetched text carries the quote", async () => {
    const module = await loadTracer();
    expect(module).not.toBeNull();
    const tracer = module!.makeSourceTracer({
      search: async () => [matchingCandidate, nonMatchingCandidate],
      fetch: async (candidate) =>
        candidate.url === matchingCandidate.url
          ? { title: "Official release", url: matchingCandidate.url, text: "Revenue increased from $1 million to $4 million in 2025." }
          : { title: "Coverage", url: nonMatchingCandidate.url, text: "Revenue was $4 million after a strong year." },
    });

    const streamed: unknown[] = [];
    const outcome = await tracer.trace(traceRequest, (event) => streamed.push(event));

    expect(outcome.sources).toEqual([
      expect.objectContaining({
        url: matchingCandidate.url,
        verification: "verified",
        excerpt: "Revenue increased from $1 million to $4 million in 2025.",
      }),
    ]);
    expect(outcome.trace).toContainEqual(expect.objectContaining({ step: "Source search", state: "done" }));
    expect(streamed).toEqual(outcome.trace);
  });

  it("ships no sources when search fails", async () => {
    const module = await loadTracer();
    expect(module).not.toBeNull();
    const tracer = module!.makeSourceTracer({
      search: async () => {
        throw new Error("search unavailable");
      },
      fetch: async () => {
        throw new Error("not reached");
      },
    });

    const outcome = await tracer.trace(traceRequest);

    expect(outcome.sources).toEqual([]);
    expect(outcome.trace).toContainEqual(expect.objectContaining({ step: "Source search", state: "failed" }));
  });

  it("opens no more than five candidates, however many the search returns", async () => {
    const module = await loadTracer();
    expect(module).not.toBeNull();
    // Every fetch is a real browser session, so the cap is a spending limit, not a tuning knob.
    const many = Array.from({ length: 12 }, (_, i) => ({ ...nonMatchingCandidate, url: `https://news.test/${i}` }));
    const fetched: string[] = [];
    const tracer = module!.makeSourceTracer({
      search: async () => many,
      fetch: async (candidate) => {
        fetched.push(candidate.url);
        return { title: "Coverage", url: candidate.url, text: "Nothing that matches." };
      },
    });

    await tracer.trace(traceRequest);

    expect(fetched).toHaveLength(5);
  });
});
