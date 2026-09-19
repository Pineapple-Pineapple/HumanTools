# Human Tools

DevTools for what a page means, not how it's built. Full product vision and the long-term panel roadmap live in [`Spec.md`](./Spec.md).

This repo currently holds the **bare MVP**: a Chromium Manifest V3 extension shell (a DevTools-styled side panel, one tab per spec panel) with a single working panel — **Accessibility** — that shows a page's local reading grade and rewrites it in plain English at a chosen grade level.

## What's built

- Click the toolbar icon to open the side panel. Nine DevTools-named tabs are shown; only **Accessibility** is enabled, the rest are visibly disabled placeholders.
- **Analyze this page** extracts the page's paragraph text on demand (nothing runs until you click) and computes a Flesch-Kincaid reading grade locally — no network call.
- Pick a target grade (6 / 9 / 12) and **Rewrite** sends the paragraphs to OpenRouter (`openai/gpt-4o-mini`) for a plain-English rewrite, applied directly on the page. Each rewritten paragraph keeps its original text in its `title` attribute (hover to see it) and gets a visible dashed outline marking it as AI-generated.
- **Restore original** reverts every rewritten paragraph in one click.
- Settings page (right-click the extension → Options, or the in-panel link) to store your own OpenRouter API key locally — it's never bundled or committed, and the background service worker is the only place it's read from.

## What's explicitly not built yet

Everything else in `Spec.md`: the other nine panels (Inspector, Network, Memory, Performance, Recorder, Console, Security, Application), Memory/Backboard, the Review Team, GPTZero/Elastic/Solana/Sovereign Mode, jargon explainer, bulleting, inline concept explanations, style presets, streaming rewrites, persistent caching, and any sponsor integrations. This is intentionally the smallest complete slice, not a stub of the whole product.

## Setup

```sh
bun install
bun run dev     # Vite + CRXJS dev server with HMR
# or
bun run build   # production build to dist/
```

Load it unpacked:

1. `bun run build`
2. Go to `chrome://extensions`, enable Developer mode
3. **Load unpacked** → select the `dist/` folder

To use Rewrite, open the extension's Options page and paste an [OpenRouter](https://openrouter.ai) API key.

## Privacy notes

- No content script runs on page load. Page access only happens after you click Analyze or Rewrite, via `chrome.scripting.executeScript` on the active tab.
- The only network call is the OpenRouter rewrite request, made from the background service worker using the key you provide — never hardcoded, never sent anywhere else.
- Rewrites are reversible: the original text for every changed paragraph is recoverable until you navigate away, and Restore original reverts them in the same session.
