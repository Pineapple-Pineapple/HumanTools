# Performance Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only Performance panel that scores cognitive load and can reversibly reduce detected distractions on the active page.

**Architecture:** Put deterministic scoring in `src/lib/performance-metrics.ts`. Self-contained functions in `src/content/functions.ts` gather serializable page signals and add or remove a uniquely named CSS style. `src/sidepanel/performance-panel.ts` invokes them only after a button press and renders the result.

**Tech Stack:** TypeScript, Chromium Manifest V3, `chrome.scripting.executeScript`, Vitest, Vite, Tailwind utility classes.

## Global Constraints

- Analyze only the active tab after an explicit click; make no network request and persist no page data.
- All scores are 0–100 heuristics, where higher means more cognitive demand; the UI must say this.
- The reducer is CSS-only and reversible. It must not hide `main`, `article`, `form`, checkout, or dialog content.
- Use the existing `pageAccessError` helper for restricted pages.
- Stage only Performance files; preserve unrelated dirty files.

---

### Task 1: Deterministic metric model

**Files:**
- Create: `src/lib/performance-metrics.ts`
- Create: `test/performance-metrics.test.ts`

**Interfaces:**
- Produces `PerformanceSignals`, `PerformanceScores`, and `scorePerformance(signals)`.
- Later tasks consume those exact exported names.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { scorePerformance } from "../src/lib/performance-metrics";

describe("scorePerformance", () => {
  it("returns zero-bounded scores for an empty page", () => {
    expect(scorePerformance({ words: 0, sentences: 0, syllables: 0, interactive: 0, topLinks: 0, viewportBlocks: 0, distractions: 0 })).toEqual({
      cognitiveLoad: 0, readingDifficulty: 0, navigation: 0, informationDensity: 0, distractions: 0,
    });
  });

  it("raises navigation and distraction scores from detected signals", () => {
    const scores = scorePerformance({ words: 300, sentences: 15, syllables: 520, interactive: 45, topLinks: 30, viewportBlocks: 3, distractions: 5 });
    expect(scores.navigation).toBeGreaterThan(0);
    expect(scores.distractions).toBeGreaterThan(0);
    expect(scores.cognitiveLoad).toBeGreaterThan(0);
    for (const score of Object.values(scores)) expect(score).toBeLessThanOrEqual(100);
  });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- test/performance-metrics.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal scorer**

```ts
export interface PerformanceSignals {
  words: number; sentences: number; syllables: number; interactive: number;
  topLinks: number; viewportBlocks: number; distractions: number;
}
export interface PerformanceScores {
  cognitiveLoad: number; readingDifficulty: number; navigation: number;
  informationDensity: number; distractions: number;
}
const bounded = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function scorePerformance(s: PerformanceSignals): PerformanceScores {
  if (s.words === 0 || s.sentences === 0) {
    return { cognitiveLoad: 0, readingDifficulty: 0, navigation: 0, informationDensity: 0, distractions: 0 };
  }
  const grade = 0.39 * (s.words / s.sentences) + 11.8 * (s.syllables / s.words) - 15.59;
  const readingDifficulty = bounded((grade - 4) * 8);
  const navigation = bounded(s.topLinks * 2 + s.interactive * 0.5);
  const informationDensity = bounded((s.words / Math.max(1, s.viewportBlocks) - 80) / 4 + s.interactive * 0.35);
  const distractions = bounded(s.distractions * 20);
  return {
    readingDifficulty, navigation, informationDensity, distractions,
    cognitiveLoad: bounded(readingDifficulty * .35 + navigation * .2 + informationDensity * .2 + distractions * .25),
  };
}
```

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- test/performance-metrics.test.ts`

Expected: PASS with 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/performance-metrics.ts test/performance-metrics.test.ts
git commit -m "feat: add performance metrics"
```

### Task 2: Page-local signal collection and reduction

**Files:**
- Modify: `src/content/functions.ts`
- Modify: `src/lib/types.ts`

**Interfaces:**
- Produces self-contained `collectPerformanceSignals(): PerformanceSignals` and `setPerformanceReduction(enabled: boolean): number`.
- The reducer returns matched count when enabling and zero when restoring.

- [ ] **Step 1: Extend the failing test**

Add a test that passes a serializable `PerformanceSignals` shape into `scorePerformance` and expects a bounded result. It must include all seven numeric fields, proving the browser boundary cannot carry DOM objects.

- [ ] **Step 2: Verify RED**

Run: `npm test -- test/performance-metrics.test.ts`

Expected: FAIL before the added signal fields are implemented.

- [ ] **Step 3: Implement collection and restoration**

Add self-contained content functions that:
1. Gather visible body text, count words and sentences, estimate syllables with vowel groups, and count visible `a, button, input, select, textarea` elements.
2. Count links whose bounding rect begins in the first viewport, visible text blocks intersecting that viewport, and distraction candidates with ad/promo/cookie/consent/popup/newsletter or common-ad-iframe signals.
3. On reduce, add `data-ht-performance-hide` only to candidates outside `main, article, form, [role=dialog]`, then inject a `#__ht-performance-reduction` style that hides only those attributes.
4. On restore, remove that style and all `data-ht-performance-hide` attributes.

- [ ] **Step 4: Verify TypeScript**

Run: `npx tsc -p tsconfig.json`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/content/functions.ts src/lib/types.ts test/performance-metrics.test.ts
git commit -m "feat: collect performance signals"
```

### Task 3: Performance panel and enabled tab

**Files:**
- Create: `src/sidepanel/performance-panel.ts`
- Create: `test/performance-panel.test.ts`
- Modify: `src/sidepanel/main.ts`
- Modify: `src/sidepanel/tabs.ts`
- Modify: `README.md`

**Interfaces:**
- Produces `mountPerformancePanel(container: HTMLElement): void`.
- Exports `performanceLabel(score: number): "Low" | "Moderate" | "High"` for direct test coverage.
- Consumes Task 1 scores and Task 2 content functions.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "vitest";
import { performanceLabel } from "../src/sidepanel/performance-panel";

it("labels load score bands", () => {
  expect(performanceLabel(20)).toBe("Low");
  expect(performanceLabel(50)).toBe("Moderate");
  expect(performanceLabel(80)).toBe("High");
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- test/performance-panel.test.ts`

Expected: FAIL because the panel does not exist.

- [ ] **Step 3: Implement the UI and integration**

Create an empty state with **Analyze this page**. Once clicked, call `collectPerformanceSignals` using `chrome.scripting.executeScript`, score it locally, and display the overall cognitive-load score plus reading difficulty, navigation, information density, and distractions. Each sub-score includes a one-sentence raw-signal explanation and a “heuristic, not a diagnosis” disclaimer.

After analysis, show **Reduce distractions**. It calls `setPerformanceReduction(true)`, reports the number of hidden elements, and changes to **Restore page**. Restore calls `setPerformanceReduction(false)` and returns to the analyzed state. Mount the new panel in `main.ts`, enable `Performance` in `tabs.ts`, and add a README bullet.

- [ ] **Step 4: Verify GREEN and build**

Run: `npm test && npx tsc -p tsconfig.json && npm run build`

Expected: all tests pass, TypeScript passes, and Vite emits a production extension build.

- [ ] **Step 5: Manual browser check**

Reload the unpacked `dist` extension. On a normal cluttered page, open **Performance**, analyze, confirm five score displays, reduce distractions, then restore and confirm the page appearance returns.

- [ ] **Step 6: Commit**

```bash
git add README.md src/sidepanel/performance-panel.ts src/sidepanel/main.ts src/sidepanel/tabs.ts test/performance-panel.test.ts
git commit -m "feat: add performance panel"
```

## Plan self-review

- Coverage: deterministic metrics, browser signal gathering, reversible action, UI, tab mounting, documentation, automated tests, and manual verification all have explicit tasks.
- Scope: remote calls, persistence, full reader mode, and model-based rewriting are excluded.
- Type consistency: Tasks 2 and 3 use the `PerformanceSignals` and `PerformanceScores` names defined in Task 1.
