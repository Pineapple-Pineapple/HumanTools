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

const remembered = {
  source: {
    title: "Official release",
    url: "https://data.gov/release",
    excerpt: "Revenue increased from $1 million to $4 million in 2025.",
    publisher: "data.gov",
    verifiedAt: new Date().toISOString(),
    sourceQuality: "institutional_signal" as const,
  },
  exact: true,
  score: 12,
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
    const indexed: string[] = [];
    const tracer = module!.makeSourceTracer({
      recall: async () => [],
      search: async () => [matchingCandidate],
      fetch: async () => ({
        title: "Inspected article",
        url: "https://page.test/article?utm_source=search",
        text: "Revenue increased from $1 million to $4 million in 2025.",
      }),
      index: async (source) => {
        indexed.push(source.url);
      },
    });

    const outcome = await tracer.trace({
      claim: "Revenue rose substantially.",
      verifiedQuote: "revenue increased from $1 million to $4 million",
      page: { url: "https://page.test/article#selected", title: "Article" },
      installId: "install-1",
    });
    const contexts = (outcome as typeof outcome & { contexts?: Array<{ contextReasons: string[] }> }).contexts;

    expect(outcome.sources).toEqual([]);
    expect(indexed).toEqual([]);
    expect(contexts).toEqual([expect.objectContaining({ contextReasons: ["page_context"] })]);
    expect(outcome.trace).toContainEqual(expect.objectContaining({ step: "Source verifier", state: "skipped", detail: "Page context only." }));
  });

  it("indexes and returns only sources whose fetched text verifies the quote", async () => {
    const module = await loadTracer();
    expect(module).not.toBeNull();
    const indexed: string[] = [];
    const tracer = module!.makeSourceTracer({
      recall: async () => [],
      search: async () => [matchingCandidate, nonMatchingCandidate],
      fetch: async (candidate) =>
        candidate.url === matchingCandidate.url
          ? { title: "Official release", url: matchingCandidate.url, text: "Revenue increased from $1 million to $4 million in 2025." }
          : { title: "Coverage", url: nonMatchingCandidate.url, text: "Revenue was $4 million after a strong year." },
      index: async (source) => {
        indexed.push(source.url);
      },
    });

    const streamed: unknown[] = [];
    const outcome = await tracer.trace(
      {
        claim: "Revenue rose substantially.",
        verifiedQuote: "revenue increased from $1 million to $4 million",
        page: { url: "https://page.test/article", title: "Article" },
        installId: "install-1",
      },
      (event) => streamed.push(event),
    );

    expect(outcome.sources).toEqual([
      expect.objectContaining({ url: matchingCandidate.url, verification: "verified", excerpt: "Revenue increased from $1 million to $4 million in 2025." }),
    ]);
    expect(indexed).toEqual([matchingCandidate.url]);
    expect(outcome.trace).toContainEqual(expect.objectContaining({ step: "Source search", state: "done" }));
    expect(outcome.trace).toContainEqual(expect.objectContaining({ step: "Source index", state: "done" }));
    expect(streamed).toEqual(outcome.trace);
  });

  it("ships no sources when search fails", async () => {
    const module = await loadTracer();
    expect(module).not.toBeNull();
    const tracer = module!.makeSourceTracer({
      recall: async () => [],
      search: async () => {
        throw new Error("search unavailable");
      },
      fetch: async () => {
        throw new Error("not reached");
      },
      index: async () => undefined,
    });

    const outcome = await tracer.trace({
      claim: "Revenue rose substantially.",
      verifiedQuote: "revenue increased from $1 million to $4 million",
      page: { url: "https://page.test/article", title: "Article" },
      installId: "install-1",
    });

    expect(outcome.sources).toEqual([]);
    expect(outcome.trace).toContainEqual(expect.objectContaining({ step: "Source search", state: "failed" }));
  });

  it("answers from the index without searching when the same quote was verified before", async () => {
    const module = await loadTracer();
    expect(module).not.toBeNull();
    let searched = false;
    const tracer = module!.makeSourceTracer({
      recall: async () => [remembered],
      search: async () => {
        searched = true;
        return [];
      },
      fetch: async () => {
        throw new Error("not reached");
      },
      index: async () => undefined,
    });

    const outcome = await tracer.trace(traceRequest);

    expect(searched).toBe(false);
    expect(outcome.sources).toEqual([expect.objectContaining({ url: remembered.source.url, verification: "verified" })]);
    expect(outcome.trace).toContainEqual(expect.objectContaining({ step: "Source recall", state: "done", detail: "1 already verified" }));
  });

  it("re-verifies a remembered source once it is older than the freshness window", async () => {
    const module = await loadTracer();
    expect(module).not.toBeNull();
    const stale = { ...remembered, source: { ...remembered.source, verifiedAt: "2020-01-01T00:00:00.000Z" } };
    const fetched: string[] = [];
    const tracer = module!.makeSourceTracer({
      recall: async () => [stale],
      search: async () => [],
      fetch: async (candidate) => {
        fetched.push(candidate.url);
        return { title: "Official release", url: candidate.url, text: stale.source.excerpt };
      },
      index: async () => undefined,
    });

    const outcome = await tracer.trace(traceRequest);

    expect(fetched).toEqual([stale.source.url]);
    expect(outcome.sources).toEqual([expect.objectContaining({ url: stale.source.url, verification: "verified" })]);
  });

  it("treats a near-miss recall as a lead and puts it ahead of the search's own candidates", async () => {
    const module = await loadTracer();
    expect(module).not.toBeNull();
    const lead = { ...remembered, exact: false };
    const fetched: string[] = [];
    const tracer = module!.makeSourceTracer({
      recall: async () => [lead],
      search: async () => [nonMatchingCandidate],
      fetch: async (candidate) => {
        fetched.push(candidate.url);
        return candidate.url === lead.source.url
          ? { title: "Official release", url: candidate.url, text: lead.source.excerpt }
          : { title: "Coverage", url: candidate.url, text: "Revenue was $4 million after a strong year." };
      },
      index: async () => undefined,
    });

    const outcome = await tracer.trace(traceRequest);

    expect(fetched[0]).toBe(lead.source.url);
    expect(fetched).toContain(nonMatchingCandidate.url);
    expect(outcome.sources).toEqual([expect.objectContaining({ url: lead.source.url })]);
    expect(outcome.trace).toContainEqual(
      expect.objectContaining({ step: "Source recall", state: "done", detail: "1 leads, none already verified" }),
    );
  });

  it("still traces when the index is unreachable", async () => {
    const module = await loadTracer();
    expect(module).not.toBeNull();
    const tracer = module!.makeSourceTracer({
      recall: async () => {
        throw new Error("index unreachable");
      },
      search: async () => [matchingCandidate],
      fetch: async () => ({
        title: "Official release",
        url: matchingCandidate.url,
        text: "Revenue increased from $1 million to $4 million in 2025.",
      }),
      index: async () => undefined,
    });

    const outcome = await tracer.trace(traceRequest);

    expect(outcome.sources).toEqual([expect.objectContaining({ url: matchingCandidate.url })]);
    expect(outcome.trace).toContainEqual(
      expect.objectContaining({ step: "Source recall", state: "failed", detail: "index unreachable" }),
    );
  });
});
