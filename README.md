# Human Tools

DevTools for what a page means, not how it's built. Full product vision and the long-term panel roadmap live in [`Spec.md`](./Spec.md).

This repo currently holds a Chromium Manifest V3 extension with working **Accessibility**, **Console**, and **Inspector** panels. The Inspector follows the source-tracing portion of the spec: it extracts claims, validates their quoted wording against the page, and can search for exact-quote matches through a companion Worker.

## What's built

- Click the toolbar icon to open the side panel. Nine DevTools-named tabs are shown; **Accessibility** and **Console** are enabled, the rest are visibly disabled placeholders.
- **Analyze this page** extracts the page's paragraph text on demand (nothing runs until you click) and computes a Flesch-Kincaid reading grade locally — no network call. Math notation (scraped MathML/LaTeX) is excluded from scoring.
- Pick a target grade (6 / 8 / 10 / 12 via slider) and **Rewrite** streams each paragraph to your provider one at a time, patching the page as soon as each one is ready instead of waiting for the whole page. Each rewritten paragraph keeps its original text in its `title` attribute (hover to see it) and gets a visible dashed outline marking it as AI-generated.
- Check **Convert to bullet points** before Rewrite to get a bulleted list per paragraph instead of prose, applied the same way — streamed and patched in as each paragraph is ready.
- **Restore original** reverts every rewritten paragraph in one click.
- **Console** is a chat panel: send a message and it silently reads the current page's paragraph text as context (once per conversation), then streams the reply token-by-token. LaTeX in replies (`$inline$` or `$$block$$`) renders with KaTeX. Conversation history lives only in memory and resets when the side panel closes.
- **Inspector** processes a selected paragraph or the page: it separates page-cited links, page context, and external verification. A same-page match is context only, never evidence; external results disclose whether they have an institutional/public-record domain signal or their credibility has not been established. It streams search and verification progress into the panel.
- Settings page (right-click the extension → Options, or the in-panel link) to pick a provider (OpenAI or OpenRouter), optionally add GPTZero for the Slop Check, and configure the source-tracing Worker endpoint. Provider keys remain local to the extension; search, browser, and index credentials remain Worker secrets.

## What's explicitly not built yet

The remaining `Spec.md` work includes Network, Memory, Performance, Recorder, Security, and Application; Memory/Backboard; the Review Team; Solana receipts; Sovereign Mode; style presets; persistent caching; and sponsor integrations. The Inspector's source tracer requires a deployed Worker and vendor credentials before it can find sources in a loaded extension.

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

### Source Tracer Worker

The source tracer is intentionally separate from the extension so that Brave Search, Browserbase, and Elasticsearch credentials are never stored in Chrome. It uses a Durable Object per extension installation to stream trace events, searches for candidate sources, opens each candidate through Browserbase, and returns only excerpts with an exact match for the page-validated quote. Exact matches from the inspected page and known non-factual publishers are shown as context, not external verification.

```sh
cd worker
npm install
cp .dev.vars.example .dev.vars
npx wrangler secret put BRAVE_SEARCH_API_KEY
npx wrangler secret put BROWSERBASE_API_KEY
npx wrangler secret put ELASTIC_URL
npx wrangler secret put ELASTIC_API_KEY
npx wrangler deploy
```

Create the Elasticsearch target as a restricted `human-tools-sources` index before deploying. After deploy, paste `https://<worker-subdomain>/v1/trace` into **Source Tracer endpoint** in the extension Options page. The extension works without that endpoint, but Inspector reports that independent source tracing is not configured.

## Privacy notes

- No content script runs on page load. Page access only happens after you click Analyze or Rewrite, or send your first Console message, via `chrome.scripting.executeScript` on the active tab.
- Network calls are made only after the corresponding panel action: rewrite/chat requests go to your chosen provider; an optional GPTZero request performs the Slop Check; and an optional source-tracer request goes to the Worker URL you configure. The Worker alone calls Brave Search, Browserbase, and Elasticsearch using its secrets.
- Rewrites are reversible: the original text for every changed paragraph is recoverable until you navigate away, and Restore original reverts them in the same session.
