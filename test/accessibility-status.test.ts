import { describe, expect, it } from "vitest";
import {
  resolveTarget,
  resolveTargets,
  rewriteButtonLabel,
  rewriteProgress,
  rewriteStopped,
  rewriteSummary,
  targetPreview,
} from "../src/sidepanel/accessibility-panel";

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

describe("rewrite summary for a single targeted paragraph", () => {
  it("names the paragraph rather than counting the page", () => {
    expect(rewriteSummary(1, 0, 8, null, true)).toBe(
      "Rewrote this paragraph at grade 8. Hover it to see the original.",
    );
  });

  it("says why the one paragraph failed", () => {
    expect(rewriteSummary(0, 1, 8, "Chat request failed (429).", true)).toBe(
      "Couldn't rewrite this paragraph: Chat request failed (429).",
    );
  });

  it("still reads as a page rewrite when no paragraph is targeted", () => {
    expect(rewriteSummary(1, 0, 8, null, false)).toBe(
      "Rewrote 1 paragraph at grade 8. Hover a paragraph to see the original.",
    );
  });
});

describe("re-finding a targeted paragraph after the page is re-read", () => {
  const blocks = [
    { id: "ht-b0", text: "The committee's determination, notwithstanding prior guidance, remains operative." },
    { id: "ht-b1", text: "A second paragraph that says something else entirely and is long enough to count." },
  ];

  it("keeps a target whose id and text both still match", () => {
    expect(resolveTarget({ blockId: "ht-b0", text: blocks[0].text }, blocks)).toEqual(blocks[0]);
  });

  it("follows the text when ids have shifted under it", () => {
    const shifted = [blocks[1], { ...blocks[0], id: "ht-b7" }];
    expect(resolveTarget({ blockId: "ht-b0", text: blocks[0].text }, shifted)).toEqual({ ...blocks[0], id: "ht-b7" });
  });

  it("does not hand back a different paragraph that merely inherited the id", () => {
    const replaced = [{ id: "ht-b0", text: "Something completely different now lives at this id." }];
    expect(resolveTarget({ blockId: "ht-b0", text: blocks[0].text }, replaced)).toBeNull();
  });

  it("matches a rewritten paragraph by id even though its text changed", () => {
    const rewritten = [{ id: "ht-b0", text: "The group decided this, and that is still true." }];
    expect(resolveTarget({ blockId: "ht-b0", text: blocks[0].text, rewritten: true }, rewritten)).toEqual(rewritten[0]);
  });

  it("drops a target whose paragraph left the page", () => {
    expect(resolveTarget({ blockId: "ht-b0", text: blocks[0].text }, [blocks[1]])).toBeNull();
  });
});

describe("rewrite progress for a single targeted paragraph", () => {
  it("says what it is doing rather than counting to one", () => {
    expect(rewriteProgress(0, 1, 0, null, true)).toBe("Rewriting this paragraph…");
  });

  it("still carries the reason when the one paragraph fails", () => {
    expect(rewriteProgress(0, 1, 1, "Chat request failed (429).", true)).toBe(
      "Rewriting this paragraph… (1 failed: Chat request failed (429))",
    );
  });
});

describe("the target chip's preview", () => {
  it("leaves a short paragraph alone", () => {
    expect(targetPreview("  A short one.  ")).toBe("A short one.");
  });

  it("collapses the whitespace a page wrapped its source with", () => {
    expect(targetPreview("wrapped\n   across   lines")).toBe("wrapped across lines");
  });

  it("cuts a long paragraph off rather than wrapping the panel forever", () => {
    const preview = targetPreview("word ".repeat(80));
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(91);
  });
});

describe("re-finding a set of targeted paragraphs", () => {
  const blocks = [
    { id: "ht-b0", text: "The committee's determination, notwithstanding prior guidance, remains operative." },
    { id: "ht-b1", text: "A second paragraph that says something else entirely and is long enough to count." },
    { id: "ht-b2", text: "A third paragraph, included here so the set has something to lose." },
  ];

  it("keeps the ones still on the page and drops the one that left", () => {
    const targets = blocks.map((b) => ({ blockId: b.id, text: b.text }));
    expect(resolveTargets(targets, [blocks[0], blocks[2]], [])).toEqual([
      { blockId: "ht-b0", text: blocks[0].text, rewritten: false },
      { blockId: "ht-b2", text: blocks[2].text, rewritten: false },
    ]);
  });

  it("keeps the order they were picked in", () => {
    const targets = [blocks[2], blocks[0]].map((b) => ({ blockId: b.id, text: b.text }));
    expect(resolveTargets(targets, blocks, []).map((t) => t.blockId)).toEqual(["ht-b2", "ht-b0"]);
  });

  it("never targets the same paragraph twice, however it was reached", () => {
    // One picked by id, one by a text anchor whose id has since shifted onto the same block.
    const targets = [
      { blockId: "ht-b0", text: blocks[0].text },
      { blockId: "ht-b9", text: blocks[0].text },
    ];
    expect(resolveTargets(targets, blocks, [])).toHaveLength(1);
  });

  it("holds a rewritten paragraph's anchor while following a clean one's text", () => {
    const rewritten = [{ id: "ht-b0", text: "The group decided this, and that is still true." }, blocks[1]];
    expect(resolveTargets(blocks.slice(0, 2).map((b) => ({ blockId: b.id, text: b.text })), rewritten, ["ht-b0"])).toEqual([
      { blockId: "ht-b0", text: blocks[0].text, rewritten: true },
      { blockId: "ht-b1", text: blocks[1].text, rewritten: false },
    ]);
  });
});

describe("stopping a rewrite mid-stream", () => {
  it("says what survived and how to undo it", () => {
    expect(rewriteStopped(7, 42)).toBe(
      "Stopped after 7 of 42 paragraphs. The 7 that landed are still on the page — Restore original puts them back.",
    );
  });

  it("reads naturally when exactly one landed", () => {
    expect(rewriteStopped(1, 3)).toBe(
      "Stopped after 1 of 3 paragraphs. The one that landed is still on the page — Restore original puts it back.",
    );
  });

  it("promises no undo when nothing had landed yet", () => {
    expect(rewriteStopped(0, 42)).toBe("Stopped before any paragraph was rewritten.");
  });
});

describe("the Rewrite button's label", () => {
  it("puts the count on the thing you press", () => {
    expect(rewriteButtonLabel(42)).toBe("Rewrite 42 paragraphs");
    expect(rewriteButtonLabel(1)).toBe("Rewrite 1 paragraph");
  });
});
