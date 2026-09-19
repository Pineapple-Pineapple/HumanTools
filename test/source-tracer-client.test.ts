import { describe, expect, it } from "vitest";

async function loadClient(): Promise<typeof import("../src/lib/source-tracer-client") | null> {
  try {
    return await import("../src/lib/source-tracer-client");
  } catch {
    return null;
  }
}

describe("source trace parsing", () => {
  it("keeps only valid independently verified sources from the Worker stream", async () => {
    const module = await loadClient();
    expect(module).not.toBeNull();

    const result = module?.parseSourceTraceLines([
      '{"type":"SOURCE_TRACE","step":"Source search","state":"done","detail":"1 candidate"}',
      '{"type":"SOURCE_TRACE_DONE","sources":[{"title":"Official release","url":"https://data.gov/release","excerpt":"Revenue increased from $1 million to $4 million.","publisher":"data.gov","verifiedAt":"2026-09-19T12:00:00.000Z","verification":"verified"},{"title":"Unverified","url":"http://news.test","excerpt":"Not enough","verification":"candidate"}]}',
    ]);

    expect(result?.trace).toEqual([expect.objectContaining({ step: "Source search", state: "done" })]);
    expect(result?.sources).toEqual([
      expect.objectContaining({ url: "https://data.gov/release", verification: "verified" }),
    ]);
  });
});
