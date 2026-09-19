# Performance Tab Design

## Goal

Add a local-first Performance panel that explains why a page is cognitively demanding and offers one reversible action to reduce obvious distractions.

## Scope

The first release exposes four 0–100 scores, where higher means more demanding:

- Reading difficulty, derived from the visible page text with a Flesch–Kincaid-style grade estimate.
- Navigation overload, derived from links and interactive controls near the top of the document.
- Information density, derived from visible words and interactive controls relative to viewport-sized content.
- Distractions, derived from fixed or sticky overlays and elements with ad, promotion, consent, popup, or autoplay signals.

The panel combines the four measures into a cognitive-load score, explains the raw signals behind each score, and labels the result as a heuristic rather than a diagnosis. It performs only on-demand analysis of the active tab and makes no network requests.

## Reduce distractions

The panel has a **Reduce distractions** button. It hides only elements identified by the distraction detector and collapses obvious navigation containers using injected, page-local CSS. The button changes to **Restore page** while active. Restore removes the injected style and leaves the underlying page DOM and storage untouched.

## Architecture

`src/content/functions.ts` will provide self-contained functions that inspect visible DOM content, produce raw metrics, and apply or remove a uniquely named performance style element. The side panel invokes those functions with `chrome.scripting.executeScript`, renders the returned scorecard, and retains the inspected tab id only to restore injected styling.

Pure scoring and normalization lives in a small `src/lib/performance-metrics.ts` module. This makes the formulas deterministic and unit-testable without a browser. The side panel only formats the already-computed result.

## Non-goals

- No remote model, Baseten call, Browserbase session, persistent history, or page rewriting.
- No claims of accessibility, security, or objective page quality.
- No removal of article content, forms, checkout controls, or user-entered data.
- No full reader-mode extraction or reading-level rewrite in this release.

## Error handling and privacy

Restricted browser pages and injection failures show the existing page-access error text. Analysis runs only after the user presses **Analyze this page**. No page text, scores, or URLs leave the extension.

## Acceptance criteria

- The Performance tab is enabled and opens a clear empty state.
- Clicking **Analyze this page** renders all four sub-scores, one overall score, and a short explanation for each within one local script execution.
- Clicking **Reduce distractions** makes a visible, CSS-only change on pages containing detected distractions; **Restore page** removes it.
- Pure metric tests cover score bounds, empty input, and the detector-to-score mapping.
