import { describe, expect, it } from "vitest";
import { computeFleschKincaidGrade } from "../src/lib/flesch-kincaid";

const SIMPLE = "The cat sat on the mat. It was warm. The dog came in and sat down too. They slept.";
const DENSE =
  "Notwithstanding the aforementioned considerations, the committee's deliberations culminated in a " +
  "comprehensive reassessment of the organization's infrastructural priorities and fiscal commitments.";

describe("computeFleschKincaidGrade", () => {
  it("scores dense prose higher than simple prose", () => {
    const simple = computeFleschKincaidGrade(SIMPLE);
    const dense = computeFleschKincaidGrade(DENSE);
    expect(simple).not.toBeNull();
    expect(dense).not.toBeNull();
    expect(dense!).toBeGreaterThan(simple!);
  });

  /**
   * The panel shows this as "—". A 0 here would be indistinguishable from the real grade of very
   * simple prose, and a page of nothing but equations is not grade-0 reading.
   */
  it("is null when there is no prose to score", () => {
    expect(computeFleschKincaidGrade("")).toBeNull();
    expect(computeFleschKincaidGrade("   \n  ")).toBeNull();
    expect(computeFleschKincaidGrade("x^2 + y^2 = z^2")).toBeNull();
    expect(computeFleschKincaidGrade("∑ ∫ ≈ 42 + 7 − 3")).toBeNull();
  });

  it("ignores math notation mixed into prose", () => {
    const prose = "Photosynthesis converts light energy into chemical energy inside the chloroplast.";
    const withMath = `${prose} $E = mc^2$ \\frac{a}{b} ∇·B = 0`;
    expect(computeFleschKincaidGrade(withMath)).toBe(computeFleschKincaidGrade(prose));
  });

  it("never reports a grade below zero", () => {
    expect(computeFleschKincaidGrade("I am. You are. We go. It is.")).toBe(0);
  });

  it("rounds to one decimal place", () => {
    const grade = computeFleschKincaidGrade(DENSE);
    expect(grade).not.toBeNull();
    expect(Math.round(grade! * 10) / 10).toBe(grade);
  });
});
