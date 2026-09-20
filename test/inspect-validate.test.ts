import { describe, expect, it } from "vitest";
import { MAX_CLAIMS, parseOutlineLabels, parseSlopResponse, validateClaims } from "../src/lib/inspect-validate";
import type { InspectTarget } from "../src/lib/types";

const TEXT =
  "Unemployment fell to 3.5 percent in March, the lowest in fifty years. " +
  "Officials said the trend would continue through the summer. " +
  "Critics argue the figure hides a shrinking labor force.";

const target: InspectTarget = {
  text: TEXT,
  paragraph: TEXT,
  blockId: "ht-i1",
  url: "https://example.com/jobs",
  title: "Jobs report",
  links: [
    { href: "https://bls.gov/report", text: "BLS report" },
    { href: "ftp://old.example/file", text: "not http" },
    { href: "https://bls.gov/report", text: "BLS report again" },
  ],
};

function claim(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    claim: "Unemployment hit a fifty-year low.",
    quote: "Unemployment fell to 3.5 percent in March, the lowest in fifty years.",
    type: "fact",
    framingFlags: [],
    evidence: { status: "unverified", sourceLinks: [] },
    ...overrides,
  };
}

describe("validateClaims", () => {
  it("keeps a claim whose quote is in the passage and records the verified span", () => {
    const { claims, dropped } = validateClaims({ claims: [claim({})] }, target);
    expect(dropped).toBe(0);
    expect(claims).toHaveLength(1);
    expect(claims[0].verifiedQuote).toBe("unemployment fell to 3.5 percent in march, the lowest in fifty years.");
  });

  it("drops a claim whose quote is not in the passage, and malformed entries", () => {
    const { claims, dropped } = validateClaims(
      { claims: [claim({ quote: "The economy is booming beyond all expectations this year." }), null, "text", claim({ claim: "" })] },
      target,
    );
    expect(claims).toHaveLength(0);
    expect(dropped).toBe(4);
  });

  it("only accepts page links by index, http(s) only, without duplicates", () => {
    const { claims } = validateClaims(
      { claims: [claim({ evidence: { status: "supported", sourceLinks: [0, 1, 2, 7, -1, "0"] } })] },
      target,
    );
    expect(claims[0].evidence.sources).toEqual([{ href: "https://bls.gov/report", text: "BLS report" }]);
    expect(claims[0].evidence.status).toBe("supported");
  });

  it("downgrades a verdict with no page source to unverified and keeps the model's read aside", () => {
    const { claims, downgraded } = validateClaims(
      { claims: [claim({ evidence: { status: "contradicted", sourceLinks: [] } })] },
      target,
    );
    expect(downgraded).toBe(1);
    expect(claims[0].evidence.status).toBe("unverified");
    expect(claims[0].evidence.unsourcedAssessment).toBe("contradicted");
  });

  it("keeps only known framing flags and falls back for an unknown type or status", () => {
    const { claims } = validateClaims(
      {
        claims: [
          claim({
            type: "rumor",
            framingFlags: [{ kind: "base_effect", note: "From a low base." }, { kind: "vibes", note: "no" }, { kind: "loaded_wording" }],
            evidence: { status: "very_true", sourceLinks: [0] },
          }),
        ],
      },
      target,
    );
    expect(claims[0].type).toBe("fact");
    expect(claims[0].evidence.status).toBe("unverified");
    expect(claims[0].framingFlags).toEqual([{ kind: "base_effect", note: "From a low base." }]);
  });

  it("orders claims by where their quote appears and drops repeats of the same span", () => {
    const later = claim({ claim: "Critics disagree.", quote: "Critics argue the figure hides a shrinking labor force." });
    const { claims, dropped } = validateClaims({ claims: [later, claim({}), claim({ claim: "Same span again." })] }, target);
    expect(claims.map((c) => c.claim)).toEqual(["Unemployment hit a fifty-year low.", "Critics disagree."]);
    expect(dropped).toBe(1);
  });

  it("caps the list at MAX_CLAIMS and counts the overflow as dropped", () => {
    const sentences = Array.from({ length: MAX_CLAIMS + 2 }, (_, i) => `Sentence number ${i} says something quite specific here.`);
    const wide: InspectTarget = { ...target, text: sentences.join(" "), paragraph: sentences.join(" ") };
    const { claims, dropped } = validateClaims(
      { claims: sentences.map((quote, i) => claim({ claim: `Claim ${i}`, quote })) },
      wide,
    );
    expect(claims).toHaveLength(MAX_CLAIMS);
    expect(dropped).toBe(2);
  });

  it("refuses a response with no claims list", () => {
    expect(() => validateClaims({}, target)).toThrow();
    expect(() => validateClaims(null, target)).toThrow();
  });
});

describe("parseSlopResponse", () => {
  it("reads the probability, class and sentences GPTZero gives", () => {
    const report = parseSlopResponse({
      documents: [
        {
          class_probabilities: { ai: 0.82, human: 0.1, mixed: 0.08 },
          predicted_class: "ai",
          confidence_category: "high",
          sentences: [{ sentence: "One.", generated_prob: 0.9 }, { sentence: "", generated_prob: 0.5 }, { generated_prob: 0.5 }],
        },
      ],
    });
    expect(report.aiProbability).toBe(0.82);
    expect(report.predictedClass).toBe("ai");
    expect(report.confidence).toBe("high");
    expect(report.sentences).toEqual([{ text: "One.", aiProbability: 0.9 }]);
  });

  it("does not invent a predicted class when GPTZero gives none", () => {
    const report = parseSlopResponse({ documents: [{ completely_generated_prob: 1.4 }] });
    expect(report.aiProbability).toBe(1);
    expect(report.predictedClass).toBe("unknown");
    expect(report.confidence).toBe("unknown");
  });

  it("refuses a response with no document or no probability", () => {
    expect(() => parseSlopResponse({ documents: [] })).toThrow();
    expect(() => parseSlopResponse({ documents: [{ predicted_class: "ai" }] })).toThrow();
  });
});

describe("parseOutlineLabels", () => {
  it("keeps only known ids with allowed labels", () => {
    const labels = parseOutlineLabels(
      { labels: [{ id: "a", label: "important" }, { id: "b", label: "shiny" }, { id: "zzz", label: "supporting" }, null] },
      new Set(["a", "b"]),
    );
    expect([...labels]).toEqual([["a", "important"]]);
  });

  it("refuses a response with no labels list", () => {
    expect(() => parseOutlineLabels({ labels: "none" }, new Set())).toThrow();
  });
});
