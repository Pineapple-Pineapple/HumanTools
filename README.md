# Human Tools

DevTools for what a page means, not how it's built. Full product vision and the long-term panel roadmap live in [`Spec.md`](./Spec.md).

This repo currently holds the **bare MVP**: a Chromium Manifest V3 extension shell (a DevTools-styled side panel, one tab per spec panel) with two working panels — **Accessibility**, which shows a page's local reading grade and rewrites it in plain English at a chosen grade level, and **Console**, a chat interface scoped to the current page.

## What's built

- Click the toolbar icon to open the side panel. Nine DevTools-named tabs are shown; **Accessibility** and **Console** are enabled, the rest are visibly disabled placeholders.
- **Analyze this page** extracts the page's paragraph text on demand (nothing runs until you click) and computes a Flesch-Kincaid reading grade locally — no network call. Math notation (scraped MathML/LaTeX) is excluded from scoring.
- Pick a target grade (6 / 8 / 10 / 12 via slider) and **Rewrite** streams each paragraph to your provider one at a time, patching the page as soon as each one is ready instead of waiting for the whole page. Each rewritten paragraph keeps its original text in its `title` attribute (hover to see it) and gets a visible dashed outline marking it as AI-generated.
- Check **Convert to bullet points** before Rewrite to get a bulleted list per paragraph instead of prose, applied the same way — streamed and patched in as each paragraph is ready.
- **Restore original** reverts every rewritten paragraph in one click.
- **Console** is a chat panel: send a message and it silently reads the current page's paragraph text as context (once per conversation), then streams the reply token-by-token. LaTeX in replies (`$inline$` or `$$block$$`) renders with KaTeX. Conversation history lives only in memory and resets when the side panel closes.
- Settings page (right-click the extension → Options, or the in-panel link) to pick a provider (OpenAI or OpenRouter) and store your own API key for it locally — keys are never bundled or committed, and the background service worker is the only place they're read from.

## What's explicitly not built yet

Everything else in `Spec.md`: the other eight panels (Inspector, Network, Memory, Performance, Recorder, Security, Application — Console is now built as a thin standalone chat, not the Inspector/Performance action-wrapper the spec describes), Memory/Backboard, the Review Team, GPTZero/Elastic/Solana/Sovereign Mode, style presets, persistent caching (the rewrite cache and chat history are in-memory and clear on service worker restart / panel close), and any sponsor integrations. This is intentionally the smallest complete slice, not a stub of the whole product.

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

To use Rewrite, open the extension's Options page, pick a provider, and paste an API key for it — [OpenAI](https://platform.openai.com/api-keys) or [OpenRouter](https://openrouter.ai/keys).

## Privacy notes

- No content script runs on page load. Page access only happens after you click Analyze or Rewrite, or send your first Console message, via `chrome.scripting.executeScript` on the active tab.
- The only network calls are the rewrite and chat requests to your chosen provider (OpenAI or OpenRouter), made from the background service worker using the key you provide — never hardcoded, never sent anywhere else.
- Rewrites are reversible: the original text for every changed paragraph is recoverable until you navigate away, and Restore original reverts them in the same session.
