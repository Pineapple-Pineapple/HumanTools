import { describe, expect, it } from "vitest";
import { rewriteProgress, rewriteSummary } from "../src/sidepanel/accessibility-panel";

/**
 * The Accessibility status line during and after a rewrite. Each of these is a sentence the reader
 * acts on — whether to wait, whether to hover, whether the key or the provider is the problem — so
 * the wording is pinned, and a failure always carries its reason.
 */
describe("rewrite status while streaming", () => {
  it("counts paragraphs as they land", () => {
    expect(rewriteProgress(3, 10, 0, null)).toBe("Rewriting… 3/10 paragraphs");
  });

  it("says why a paragraph failed instead of only that it did", () => {
    expect(rewriteProgress(4, 10, 1, "Chat request failed (429).")).toBe(
      "Rewriting… 4/10 paragraphs (1 failed: Chat request failed (429))",
    );
  });

  it("still counts a failure that came with no message", () => {
    expect(rewriteProgress(4, 10, 2, "")).toBe("Rewriting… 4/10 paragraphs (2 failed)");
  });
});

describe("rewrite summary", () => {
  it("promises a hover only when something was rewritten", () => {
    expect(rewriteSummary(10, 0, 8, null)).toBe("Rewrote 10 paragraphs at grade 8. Hover a paragraph to see the original.");
    expect(rewriteSummary(0, 3, 8, "Chat request failed (429).")).toBe(
      "Couldn't rewrite any of the 3 paragraphs: Chat request failed (429).",
    );
    expect(rewriteSummary(0, 1, 6, null)).toBe("Couldn't rewrite any of the 1 paragraph.");
  });

  it("reports a partial rewrite with its count and reason", () => {
    expect(rewriteSummary(8, 2, 10, "Chat request failed (429).")).toBe(
      "Rewrote 8 of 10 paragraphs at grade 10; 2 failed: Chat request failed (429). Hover a paragraph to see the original.",
    );
    expect(rewriteSummary(8, 2, 10, null)).toBe(
      "Rewrote 8 of 10 paragraphs at grade 10; 2 failed. Hover a paragraph to see the original.",
    );
  });

  it("uses the singular for one paragraph", () => {
    expect(rewriteSummary(1, 0, 6, null)).toBe("Rewrote 1 paragraph at grade 6. Hover a paragraph to see the original.");
  });
});
