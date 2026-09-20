import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSourceTraceLines, requestSourceTrace } from "../src/lib/source-tracer-client";

describe("source trace parsing", () => {
  it("rejects an external source whose quality is not disclosed", () => {
    const result = parseSourceTraceLines([
      JSON.stringify({
        type: "SOURCE_TRACE_DONE",
        sources: [{
          title: "Unassessed publisher",
          url: "https://example.net/report",
          excerpt: "Claim text.",
          publisher: "example.net",
          verifiedAt: "2026-09-19T12:00:00.000Z",
          verification: "verified",
        }],
      }),
    ]);

    expect(result.sources).toEqual([]);
  });

  it("keeps valid context separately from verified external sources", () => {
    const result = parseSourceTraceLines([
      JSON.stringify({
        type: "SOURCE_TRACE_DONE",
        sources: [],
        contexts: [{
          title: "Satire article",
          url: "https://theonion.com/story",
          excerpt: "Claim text.",
          publisher: "theonion.com",
          verifiedAt: "2026-09-19T12:00:00.000Z",
          verification: "context",
          contextReasons: ["page_context", "non_factual_context"],
        }],
      }),
    ]);

    expect(result.sources).toEqual([]);
    expect(result.contexts).toEqual([expect.objectContaining({ verification: "context" })]);
  });

  it("keeps only valid independently verified sources from the Worker stream", () => {
    const result = parseSourceTraceLines([
      '{"type":"SOURCE_TRACE","step":"Source search","state":"done","detail":"1 candidate"}',
      '{"type":"SOURCE_TRACE_DONE","sources":[{"title":"Official release","url":"https://data.gov/release","excerpt":"Revenue increased from $1 million to $4 million.","publisher":"data.gov","verifiedAt":"2026-09-19T12:00:00.000Z","sourceQuality":"institutional_signal","verification":"verified"},{"title":"Unverified","url":"http://news.test","excerpt":"Not enough","verification":"candidate"}]}',
    ]);

    expect(result.trace).toEqual([expect.objectContaining({ step: "Source search", state: "done" })]);
    expect(result.sources).toEqual([
      expect.objectContaining({ url: "https://data.gov/release", verification: "verified", sourceQuality: "institutional_signal" }),
    ]);
  });

  it("ignores records that are not JSON objects", () => {
    expect(parseSourceTraceLines(["42", "null", '"text"', "{bad"])).toEqual({ trace: [], sources: [], contexts: [] });
  });
});

describe("requestSourceTrace", () => {
  afterEach(() => vi.unstubAllGlobals());

  const request = { claim: "c", verifiedQuote: "q", page: { url: "https://p", title: "P" }, installId: "i" };

  it("reports each trace event as its line completes and keeps a final line without a newline", async () => {
    const done = '{"type":"SOURCE_TRACE_DONE","sources":[{"title":"Official release","url":"https://data.gov/release","excerpt":"q","publisher":"data.gov","verifiedAt":"2026-09-19T12:00:00.000Z","sourceQuality":"institutional_signal","verification":"verified"}]}';
    const chunks = [
      '{"type":"SOURCE_TRACE","step":"Source sea',
      'rch","state":"running"}\n{"type":"SOURCE_TRACE","step":"Source search","state":"done"}\n',
      done,
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

    const seen: string[] = [];
    const result = await requestSourceTrace("https://worker/v1/trace", request, (event) => seen.push(event.state));

    expect(seen).toEqual(["running", "done"]);
    expect(result.trace).toHaveLength(2);
    expect(result.sources).toEqual([expect.objectContaining({ url: "https://data.gov/release" })]);
  });

  it("passes the abort signal to fetch", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await requestSourceTrace("https://worker/v1/trace", request, () => {}, controller.signal);

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal });
  });
});
