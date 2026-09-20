import { describe, expect, it } from "vitest";
import { LIMITS, parseTraceRequest, readTraceRequest } from "../src/trace-request";

const valid = {
  claim: "Revenue rose.",
  verifiedQuote: "revenue increased",
  page: { url: "https://example.test", title: "Example" },
  installId: "install-1",
};

describe("parseTraceRequest", () => {
  it("accepts a well-formed request and keeps only its known fields", () => {
    expect(parseTraceRequest({ ...valid, extra: "dropped" })).toEqual({ ok: true, request: valid });
  });

  it("names the first missing field", () => {
    expect(parseTraceRequest({ claim: "x", page: valid.page })).toEqual({ ok: false, error: "verifiedQuote is required." });
    expect(parseTraceRequest({ ...valid, installId: "  " })).toEqual({ ok: false, error: "installId is required." });
    expect(parseTraceRequest({ ...valid, page: null })).toEqual({ ok: false, error: "page.url is required." });
    expect(parseTraceRequest("a string")).toEqual({ ok: false, error: "Request body must be a JSON object." });
  });

  it("caps every text field", () => {
    expect(parseTraceRequest({ ...valid, claim: "c".repeat(LIMITS.claim + 1) })).toEqual({ ok: false, error: `claim exceeds ${LIMITS.claim} characters.` });
    expect(parseTraceRequest({ ...valid, verifiedQuote: "q".repeat(LIMITS.verifiedQuote + 1) })).toEqual({
      ok: false,
      error: `verifiedQuote exceeds ${LIMITS.verifiedQuote} characters.`,
    });
    expect(parseTraceRequest({ ...valid, installId: "i".repeat(LIMITS.installId + 1) })).toEqual({
      ok: false,
      error: `installId exceeds ${LIMITS.installId} characters.`,
    });
    expect(parseTraceRequest({ ...valid, page: { ...valid.page, url: `https://x.test/${"p".repeat(LIMITS.pageUrl)}` } })).toEqual({
      ok: false,
      error: `page.url exceeds ${LIMITS.pageUrl} characters.`,
    });
    expect(parseTraceRequest({ ...valid, claim: "c".repeat(LIMITS.claim) })).toMatchObject({ ok: true });
  });
});

describe("readTraceRequest", () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    new Request("https://worker.test/v1/trace", { method: "POST", headers, body });

  it("refuses a body that is not JSON", async () => {
    await expect(readTraceRequest(post("<html>", { "content-type": "text/html" }))).resolves.toEqual({ ok: false, error: "Invalid JSON." });
  });

  it("refuses an oversized body before parsing it", async () => {
    const padded = JSON.stringify({ ...valid, padding: "x".repeat(LIMITS.body) });
    await expect(readTraceRequest(post(padded))).resolves.toEqual({ ok: false, error: "Request body is too large." });
    await expect(readTraceRequest(post("{}", { "content-length": String(LIMITS.body + 1) }))).resolves.toEqual({
      ok: false,
      error: "Request body is too large.",
    });
  });
});
