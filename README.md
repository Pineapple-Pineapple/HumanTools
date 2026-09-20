# Human Tools

DevTools for what a page *means*, not how it's built. A Chromium side panel with five tabs named after DevTools panels, each answering a human question about the page in front of you.

New here? [**GETTING-STARTED.md**](./GETTING-STARTED.md) is the walkthrough and the setup guide: installing it, where every key comes from, and using each panel once on a real page. This file is the reference for what the tool is and how it behaves.

| Panel | Question | Needs a key? |
| --- | --- | --- |
| **Accessibility** | Make this understandable. | Grading: no. Rewriting: yes. |
| **Console** | Ask the page. | Yes |
| **Inspector** | What am I looking at, and where did it come from? | Yes |
| **Security** | Is this safe? | No — local, with two opt-in network buttons |
| **Application** | What is this site doing with me? | No — fully local |

[`Spec.md`](./Spec.md) is the original product vision and describes a larger product (Network, Memory, Performance, Recorder, and a set of sponsor integrations). Those are not built and this repo does not track them; the code here is the source of truth. `docs/superpowers/` holds point-in-time design docs for the Inspector's source tracer and a Performance tab that was never built.

## What each panel does

**Accessibility** reads the page's paragraphs the moment the panel is shown and prints a Flesch–Kincaid reading grade — computed locally, no network. Pick a target grade (6–12) and **Rewrite** streams each paragraph to your provider one at a time, patching the page as each one lands; check **Convert to bullet points** for a list per paragraph instead. Every rewritten paragraph is outlined as generated and shows its original on hover. **Restore original** puts back the paragraph's actual markup — links, emphasis, images — not just its text.

**Console** is a chat about the page. The page's text and links are handed to the model as data in their own turn, never inside the instructions. Answers must quote the page verbatim; every quote is checked against the real page text, and verified ones become numbered badges that scroll the page to the passage. Each browser tab keeps its own thread. **Stop** cuts a reply short; a reply that goes silent for 90 s is ended with a note.

**Inspector** takes a selection or a picked paragraph and extracts claims. Every claim's quote must be found verbatim in the passage or it is dropped by code, not by the model; cited sources can only be links the page itself contains. Each card shows claim type, evidence status (supported / partly supported / unverified / contradicted), framing flags, and what could not be checked. Numbered badges on the page click back to their cards, and survive tab switches, panel reopening and reload. Optional: a GPTZero **Slop Check** (a probability, never proof of authorship) and external source tracing (below). **Outline** mode labels the page's blocks as important, supporting, navigation, ad or boilerplate.

**Security** reads what the page itself shows: transport, where every form posts and what it collects, links whose text names a different site than their target, punycode hostnames (decoded), third-party code origins, and every frame and open shadow root. Findings carry a severity each — never summed into a score, never a verdict. Two buttons reach the network **only when pressed** and say what they send first: domain age via RDAP, and following a flagged link's redirects.

**Application** classifies what the page asks you to type, names the outside domains whose code runs on it, measures dark patterns (pre-ticked boxes, confirmshaming, scarcity claims, exits made hard to find, overlay walls), and lists cookies, storage and granted permissions. Every finding says whether it was read off the page or matched against the extension's own short pattern list.

Every panel ends with **Blind spots**: only real, current limits of that reading, as chips whose full sentence is the hover text.

### What runs when

- Nothing runs on a page until the panel is open. No content script is registered; everything is injected on demand.
- Free, local work (grading, Security and Application scans) re-runs automatically when you switch tabs or a page navigates, and only for the panel you are looking at.
- Anything that spends your API key — rewriting, chatting, claim extraction, Outline's label refinement — runs only when you press its button. Switching tabs swaps what is displayed; it never re-spends.
- Results are kept per tab and dropped when that tab navigates or closes.

## Setup

Step by step, including which accounts and keys each panel needs and where to get them: [**GETTING-STARTED.md**](./GETTING-STARTED.md). In outline — build, load `dist/` unpacked at `chrome://extensions`, then paste an **OpenAI** or **OpenRouter** key into the extension's **Options** and press **Test**. A GPTZero key (Slop Check) and Brave Search / Browserbase keys (source tracing, below) are optional.

```sh
bun install
bun run dev     # Vite + CRXJS with HMR
bun run build   # production build to dist/
bun run test    # vitest
```

Keys stay in `chrome.storage.local`; the background service worker is the only place one is read. The panels call `gpt-4o-mini` (`openai/gpt-4o-mini` through OpenRouter).

## Privacy

- **Local by default.** Security and Application never touch the network on a scan. Grading is local.
- **Provider calls** (rewrite, chat, claims, outline labels) go only to the provider you picked, from the service worker, with page text passed as data. They happen only on your button press.
- **GPTZero** receives the inspected passage, only if you added a key.
- **Security's two buttons** state, before you press them, that one sends a hostname to `rdap.org` and the other contacts a link's destination from your IP.
- **Source tracing** sends a claim's quote to Brave Search, and opens the results it finds — through Browserbase's cloud browser if you gave it a key, otherwise fetched directly from here, which reveals your address to those pages. Only if you added a Brave key.
- Rewrites are reversible until the page reloads.

## Source tracing (optional)

Inspector can look for a claim's sources *outside* the page: it searches Brave for the claim's exact quote, opens what it finds, and keeps only pages where that quote is really present. Add a **Brave Search API key** in Options to turn it on. Without one, external verification reads "Not checked", which is true rather than flattering.

A **Browserbase key** is optional on top of that. With it, candidates are opened in a cloud browser — which reads pages that build their text with script, and keeps your address off them. Without it they are fetched straight from the extension: free and much faster, but a script-rendered page arrives empty and simply fails to verify.

Each claim costs one search and up to five page loads, every time; nothing is cached between traces, so inspecting the same paragraph again costs the same again.

This used to be a Cloudflare Worker you deployed yourself, on the principle that search and browser credentials should never sit in a browser. That guarded a shared service which never existed — every install deployed its own Worker with its own keys — so the deployment step protected your keys from you, while the provider key that can actually run up a bill sat in extension storage the whole time. `docs/removing-the-worker.md` is the record of that decision.

## Working on it

- **Injected functions** (`src/content/*.ts`) are passed to `chrome.scripting.executeScript` by reference and re-evaluated inside the page from their own source text. They cannot reference anything from module scope — not imports, not sibling constants — or they throw inside the page and silently return nothing. Every constant lives inside the function body; only `import type` is safe. This has caused real bugs twice; the header comment on `extractPageBlocks` is the canonical statement.
- **Judgement lives in `src/lib/`** as pure functions, so it is unit-tested; collectors in `src/content/` only measure.
- `src/sidepanel/ui.ts` owns the DOM helper, error wording and class tokens shared by every panel; `src/lib/tab-state.ts` owns which tab is in front of the reader and per-tab result stores.
- `bun run test` covers the pure modules (192 tests). The panels and collectors are exercised by hand: load unpacked, and try a chrome:// page, a page with an iframe, a tab switch mid-run, and a reload with rewrites applied.
