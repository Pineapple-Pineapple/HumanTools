import { describe, expect, it } from "vitest";
import { findVerifiedCore, normalizeWhitespace } from "../src/lib/quote-match";
import { heuristicClaimType, splitSentences } from "../src/lib/claim-heuristics";

const PAGE = normalizeWhitespace(
  `The council approved the plan on Tuesday, after   months of debate,
   and the mayor said construction would begin next spring.`,
).toLowerCase();

describe("findVerifiedCore", () => {
  it("returns the whole quote when it is in the text, normalized", () => {
    expect(findVerifiedCore(PAGE, "  The Council approved\nthe plan on Tuesday ")).toBe("the council approved the plan on tuesday");
  });

  it("forgives a few trimmed boundary words but returns only the span that is really there", () => {
    // A leading connector the model added, and a last word whose punctuation it changed: both
    // fall off, and what comes back is exactly the run of words the page has.
    expect(findVerifiedCore(PAGE, "Then the council approved the plan on Tuesday, after months of debate!")).toBe(
      "the council approved the plan on tuesday, after months of",
    );
  });

  it("refuses a paraphrase: fewer than six surviving words, or under 60% of the quote", () => {
    expect(findVerifiedCore(PAGE, "the council approved something else entirely")).toBeNull();
    // Only "the plan on tuesday" survives (4 words) — too short to count as a citation.
    expect(findVerifiedCore(PAGE, "xx yy the plan on tuesday zz ww")).toBeNull();
    // Eight of nine words are wrong; the one that matches is not a quote.
    expect(findVerifiedCore(PAGE, "a b c d e f g h tuesday")).toBeNull();
  });

  it("returns null for an empty quote", () => {
    expect(findVerifiedCore(PAGE, "   ")).toBeNull();
  });
});

describe("splitSentences", () => {
  it("splits on sentence punctuation followed by a capital, keeping decimals and quotes whole", () => {
    expect(splitSentences('Growth was 3.5% last year. "It will rise," she said. Nobody objected!')).toEqual([
      "Growth was 3.5% last year.",
      '"It will rise," she said.',
      "Nobody objected!",
    ]);
  });

  it("drops empty pieces", () => {
    expect(splitSentences("   ")).toEqual([]);
  });
});

describe("heuristicClaimType", () => {
  it("ranks cues from strongest override down to a plain statement of fact", () => {
    expect(heuristicClaimType('"We will win," the coach said.')).toBe("quote");
    expect(heuristicClaimType("Prices will double by 2030.")).toBe("prediction");
    expect(heuristicClaimType("The bridge may need repairs.")).toBe("speculation");
    expect(heuristicClaimType("The council should have acted sooner.")).toBe("opinion");
    expect(heuristicClaimType("The bridge opened in 1932.")).toBe("fact");
  });
});
