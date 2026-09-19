import { describe, expect, it } from "vitest";
import {
  detectCurrency,
  figureOccursIn,
  parseFigure,
  parseMagnitude,
  parseNumeral,
  parseScaleNote,
  resolveCurrency,
} from "../src/lib/finance-units";
import type { ParsedAmount, ParsedPercent } from "../src/lib/finance-units";

function amount(raw: string, scale: number | null = null, hints: string[] = []): ParsedAmount {
  const figure = parseFigure(raw, { scale, currencyHints: hints });
  if (!figure || figure.kind !== "amount") throw new Error(`expected an amount from ${JSON.stringify(raw)}`);
  return figure;
}

function percent(raw: string, scale: number | null = null): ParsedPercent {
  const figure = parseFigure(raw, { scale });
  if (!figure || figure.kind !== "percent") throw new Error(`expected a percentage from ${JSON.stringify(raw)}`);
  return figure;
}

describe("magnitude words in prose", () => {
  it("reads the words and the abbreviations", () => {
    expect(amount("$1.2 billion").value).toBe(1.2e9);
    expect(amount("4.5M").value).toBe(4.5e6);
    expect(amount("3 bn").value).toBe(3e9);
    expect(amount("£800k").value).toBe(800_000);
    expect(amount("2.3 trillion").value).toBe(2.3e12);
    expect(amount("$1.2 billion").namedScale).toBe(1e9);
  });

  it("normalizes to the base unit, not to the unit the page wrote in", () => {
    expect(amount("$4.2 million").value).toBe(4_200_000);
    expect(parseMagnitude("bn")).toBe(1e9);
    expect(parseMagnitude("thousands")).toBe(1e3);
    expect(parseMagnitude("squillion")).toBeNull();
  });

  it("refuses a string that is more than one figure", () => {
    expect(parseFigure("about $5 million")).toBeNull();
    expect(parseFigure("$12m of $30m")).toBeNull();
    expect(parseFigure("150 bps")).toBeNull();
    expect(parseFigure("n/a")).toBeNull();
    expect(parseFigure("")).toBeNull();
  });
});

describe("grouped numerals", () => {
  it("reads the unambiguous groupings", () => {
    expect(parseNumeral("1,200")).toBe(1200);
    expect(parseNumeral("1 200")).toBe(1200);
    expect(parseNumeral("1'200")).toBe(1200);
    expect(parseNumeral("12,345,678")).toBe(12_345_678);
    expect(parseNumeral("1200")).toBe(1200);
  });

  it("reads a decimal separator by which one comes last", () => {
    expect(parseNumeral("1.200,50")).toBe(1200.5);
    expect(parseNumeral("1,200.50")).toBe(1200.5);
    expect(parseNumeral("1 200,50")).toBe(1200.5);
    expect(parseNumeral("3.5")).toBe(3.5);
    expect(parseNumeral("1,5")).toBe(1.5);
  });

  it("refuses the shapes that genuinely do not say", () => {
    // "1.200" is 1200 to half the world and 1.2 to the other half; nothing in the string decides.
    expect(parseNumeral("1.200")).toBeNull();
    expect(parseNumeral("0.500")).toBe(0.5);
    expect(parseNumeral("1,20,000")).toBeNull();
    expect(parseNumeral("12.")).toBeNull();
    expect(parseNumeral("1,2,3.4")).toBeNull();
    expect(parseNumeral("twelve")).toBeNull();
  });
});

describe("scale headers", () => {
  it("reads the multiplier a table caption states", () => {
    expect(parseScaleNote("(in millions)")).toBe(1e6);
    expect(parseScaleNote("$ in thousands")).toBe(1e3);
    expect(parseScaleNote("in billions of dollars")).toBe(1e9);
    expect(parseScaleNote("(in millions, except per share data)")).toBe(1e6);
    expect(parseScaleNote("$ in 000s")).toBe(1e3);
  });

  it("says nothing when the note says nothing, or says two things", () => {
    expect(parseScaleNote("")).toBeNull();
    expect(parseScaleNote("Revenue by segment")).toBeNull();
    expect(parseScaleNote("in millions, except share counts in thousands")).toBeNull();
    expect(parseScaleNote("net income over $1,000")).toBeNull();
  });

  it("applies the table's scale to a bare cell", () => {
    const cell = amount("1,200", 1e6);
    expect(cell.value).toBe(1.2e9);
    expect(cell.scaleApplied).toBe(true);
    expect(cell.namedScale).toBeNull();
  });

  it("never scales a cell that names its own magnitude twice", () => {
    const cell = amount("$1.2 billion", 1e6);
    expect(cell.value).toBe(1.2e9);
    expect(cell.scaleApplied).toBe(false);
    expect(cell.namedScale).toBe(1e9);
  });
});

describe("accounting negatives", () => {
  it("reads a parenthesised figure as negative", () => {
    expect(amount("(3,410)").value).toBe(-3410);
    expect(amount("($3,410)").value).toBe(-3410);
    expect(amount("-$1.2M").value).toBe(-1.2e6);
  });

  it("scales a negative cell like any other cell", () => {
    expect(amount("(3,410)", 1e3).value).toBe(-3_410_000);
  });
});

describe("percentages", () => {
  it("stays a percentage, and is never an amount", () => {
    expect(percent("12.5%").value).toBe(12.5);
    expect(percent("12 percent").value).toBe(12);
    expect(percent("(2.5%)").value).toBe(-2.5);
  });

  it("is not touched by a table's scale", () => {
    expect(percent("12%", 1e6).value).toBe(12);
  });

  it("refuses a percentage wearing a currency or a magnitude", () => {
    expect(parseFigure("$12%")).toBeNull();
    expect(parseFigure("1.2 million percent")).toBeNull();
  });
});

describe("currency", () => {
  it("reads a symbol or a code", () => {
    expect(detectCurrency("1.2bn USD")).toBe("USD");
    expect(detectCurrency("US$1.2bn")).toBe("USD");
    expect(detectCurrency("£800k")).toBe("GBP");
    expect(detectCurrency("€1.200,50")).toBe("EUR");
    expect(detectCurrency("1,200")).toBeNull();
    expect(amount("€1.200,50").value).toBe(1200.5);
  });

  it("leaves an ambiguous symbol ambiguous", () => {
    expect(detectCurrency("$1.2bn")).toBe("$");
    expect(detectCurrency("¥5,000")).toBe("¥");
    expect(resolveCurrency("$", ["USD", "CAD"])).toBe("$");
    expect(resolveCurrency("$", ["$"])).toBe("$");
  });

  it("resolves it when the rest of the page names exactly one dollar", () => {
    expect(detectCurrency("$1.2bn", ["CAD"])).toBe("CAD");
    expect(amount("$5 million", null, ["$", "CAD"]).currency).toBe("CAD");
    expect(amount("$5 million", null, ["USD", "CAD"]).currency).toBe("$");
    expect(amount("1,200").currency).toBeNull();
  });
});

describe("finding a figure inside its own sentence", () => {
  it("matches across the spacing a page happens to use", () => {
    expect(figureOccursIn("Revenue was $1.2 billion this year.", "$1.2 billion")).toBe(true);
    expect(figureOccursIn("Revenue was $1.2 billion this year.", "$4.2 billion")).toBe(false);
    expect(figureOccursIn("Revenue was $1.2 billion this year.", "")).toBe(false);
  });
});
