# Getting started

A first session with Human Tools: install it, give it a key, and use each panel once on a real page. About fifteen minutes. Everything you have to set up lives here — where each key comes from, including the optional ones for source tracing ([§7](#7-optional-source-tracing)). [`README.md`](./README.md) says what the tool is and how it behaves; this is the walkthrough.

## 1. Install it

```sh
bun install
bun run build
```

Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and pick the `dist/` folder inside this repo.

Pin it: click the puzzle-piece icon in Chrome's toolbar and pin **Human Tools**. You'll be clicking it a lot.

Now open a real article in a tab — a news story or a blog post with several paragraphs — and click the Human Tools icon. The side panel opens on the right with five tabs: **Accessibility, Console, Inspector, Security, Application**.

At the top you'll see a banner:

> Human Tools reads the page in front of you. Security and Application work right away; Accessibility, Console and Inspector need an API key from OpenAI or OpenRouter.

That's true, and it's the shape of the whole tool. Start with the two that need nothing.

## 2. The two panels that work immediately

### Security — "is this safe?"

Click the **Security** tab, then **Check this page**.

It reads the page and reports: whether it arrived over https, how many forms it has and where each one posts, how many links and how many go somewhere other than what they say, and how many outside domains run code on it. Findings are listed with a severity each — *Worth stopping for*, *Worth knowing*, *Context*. Click any finding to open its explanation and the exact evidence it came from.

Two things to notice:

- **There is no score.** No grade, no "this site is safe". Severities are per finding and never added up, because a number would be a verdict, and the panel doesn't make verdicts.
- **Blind spots** at the bottom. Each chip is something this reading could *not* see; hover it for the full sentence. That list is only ever things that are genuinely true right now.

Under *Checks that reach the network — only when you press them* are two buttons. Nothing above them has touched the network. Each says what it will send before you press it:

- **How old is this domain, and who sold it?** sends the hostname to `rdap.org`. A domain registered days ago is one of the strongest phishing signals there is — but a twenty-year-old domain isn't a clean bill of health either, and the panel says so.
- **Where does a link actually land?** appears for links the scan flagged. It contacts that address *from your own IP*, which on a tracking shortener is close to indistinguishable from clicking it.

Try this on a news site with a cookie banner and a few ad scripts — you'll get much more to look at than on a clean blog.

### Application — "what is this site doing with me?"

Click **Application**, then **Scan this page**.

Four bands: what the page asks you to type, which outside domains it loads code from, where it leans on you to say yes, and what it has already stored in your browser. Zero counts are shown rather than hidden — *we looked and found nothing* is a result.

Every finding carries a chip: **Read off the page** or **Matched a pattern**. That's the honest line between a fact (this checkbox really is pre-ticked) and a guess (this domain is on our short list of trackers). The pattern list is small and not exhaustive, which the blind spots say.

A shopping or newsletter signup page gives you far more here than an article does.

## 3. Add a key

The other three panels send text to a model, so they need your own API key. One provider is enough:

- **OpenAI** — create a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). The extension calls `gpt-4o-mini`. The API bills separately from a ChatGPT subscription, so the account needs credit on it.
- **OpenRouter** — [openrouter.ai/keys](https://openrouter.ai/keys). One key for many providers; the extension asks it for `openai/gpt-4o-mini`. Also needs credit.

At those prices a rewritten article or a paragraph's worth of claims costs a fraction of a cent — but it is your money, which is why nothing spends it without a button press.

Right-click the extension icon → **Options** (or click **Set API key** in any panel).

1. Pick **OpenAI** or **OpenRouter**. Either works.
2. Paste the key into that provider's field. Typing into a field selects its provider automatically, so you can't strand a key behind the wrong radio.
3. Press **Test key**. It sends only the key, as typed, to a free read-only endpoint and reports **Key accepted.** or the rejection. Nothing is generated or billed.
4. **Save**.

Keys are written to `chrome.storage.local` and read in exactly one place, the extension's background service worker. There is no Human Tools server in the middle: calls go from your browser to the provider you picked.

Two optional fields you can ignore for now:

- **GPTZero API key** — turns on Inspector's Slop Check, an AI-text probability for a passage. Keys come from the [GPTZero API dashboard](https://app.gptzero.me/app/api).
- **Brave Search key**, and optionally a **Browserbase key** — these let Inspector look for a claim's sources out on the web. Leave them empty for now; [§7](#7-optional-source-tracing) covers them. Without them, Inspector works fine and honestly reports external sources as *Not checked* rather than pretending it looked.

Back in the panel, the banner is gone.

## 4. Accessibility — make this understandable

Click **Accessibility**. It has already read the page and printed a **Reading grade** — the Flesch–Kincaid US grade level, computed on your machine with no network call. A dense news article usually lands around 11–14.

Drag **Rewrite for grade** to 8 and press **Rewrite**.

Paragraphs are rewritten one at a time and patched onto the page as each lands, so the page starts changing within a second or two rather than after a long wait. Each rewritten paragraph gets a dashed amber outline marking it as generated — **hover one to see the original text**. When it finishes, the grade is recomputed and tells you what moved.

Tick **Convert to bullet points** and rewrite again for a list per paragraph instead of prose.

**Restore original** puts the page back — including links, emphasis and images inside those paragraphs, not just the words.

Worth knowing: grading is free and re-runs on its own when you switch tabs or a page navigates. Rewriting spends your key, so it only ever happens when you press the button. Switching tabs swaps what's displayed; it never re-spends.

## 5. Console — ask the page

Click **Console**. The header names the page it's reading. Type a question — *what is this article actually claiming?* — and press Enter.

The reply streams in. Where it draws on the page, it quotes the page verbatim, and **every quote is checked against the real page text**. Verified quotes get a numbered badge; click one to scroll the page to that passage. A quote that can't be found is quietly downgraded to plain text rather than dressed up as evidence.

While a reply streams, **Send** becomes **Stop** — press it to cut the answer short; the partial text stays with a note. Each browser tab keeps its own conversation, so switching away and back finds your thread as you left it, draft included. **New chat** clears the current tab's thread only.

Switch to a different page and ask another question: the panel re-reads the page and says so in the transcript, rather than silently answering about the page you left.

## 6. Inspector — what am I looking at?

The deepest panel. Click **Inspector**.

Press **Pick paragraph**, then hover the page — claim-bearing sentences get underlined. Click a paragraph. (Or select some text yourself and press **Inspect selection**.)

You get a card per claim. Each shows:

- **The claim**, restated plainly, and the exact sentence it came from.
- **Type** — Fact, Opinion, Speculation, Prediction, Quote. Hover for what each means.
- **Evidence status** — Supported, Partly supported, Unverified, Contradicted. Never "true" or "false". Hover for the definition; *Unverified* reads "Nothing on the page backs this claim, so no verdict is given. Not a finding that the claim is wrong."
- **Framing flags** where they apply — Base effect, Cherry-picked window, Missing denominator, Relative vs absolute, Loaded wording. A "300% increase" from a tiny base gets caught here.
- **What we could not check.**

On the page itself, each claim gets a numbered badge. Click a badge to jump to its card; click a card's **Show on page** to jump the other way. Those badges survive tab switches, closing and reopening the panel, and reloading the page.

Open **Trace** to watch the pipeline: capture, a first local read done with no model at all, claim extraction, the verifier, and source tracing if you configured it. The verifier's numbers are worth reading — it reports how many claims it *dropped* because their quote wasn't literally in the passage. That check is code, not the model's word.

Switch the segmented control to **Outline** and press **Outline this page** for a tree of the page's blocks labelled important, supporting, navigation, ad or boilerplate. Tick **Show labels on page** to draw them in place.

**Clear** removes the badges and the cards.

## 7. Optional: source tracing

Everything above works from the page in front of you. This is the one feature that looks *outside* it: Inspector searches for a claim's exact quote, opens what it finds, and keeps only pages where that quote is really there. Skip it and Inspector still works — external sources read *Not checked*, which is true rather than flattering.

It needs one key, and optionally a second.

| | Where to get it | What it costs |
| --- | --- | --- |
| **Brave Search** — required | [api-dashboard.search.brave.com](https://api-dashboard.search.brave.com/) → subscribe to a Web Search plan → **API Keys** | Metered: roughly $5 of free credit a month (about 1,000 queries), and a card is required even to stay inside it. |
| **Browserbase** — optional | [browserbase.com](https://www.browserbase.com/) → **Settings** | Free plan: 3 concurrent browsers and about one browser-hour, no card. The key is all you need — the project is inferred from it. |

Paste them into Options and **Save**.

**What the Browserbase key changes.** With it, a candidate page is opened in a real cloud browser: pages that build their text with script are read properly, and your address never reaches the page. Without it, the extension fetches the page directly — free, much faster, no account — but a script-rendered page arrives as an empty shell and simply fails to verify, and the site sees your IP. Neither is wrong; the first is more thorough, the second is simpler.

**Budget before you start.** One claim is one search and up to five page loads, and nothing is cached — a paragraph with ten claims can be ten searches and fifty page loads, and inspecting it again costs the same again.

### See it work

Inspect a paragraph that leans on something external — a news story citing a study — and open **Trace**. You should see **Source search**, **Source fetch** and **Source verifier** steps with their timings, and cards naming external sources with the excerpt that matched.

### If tracing looks wrong

- **Every claim still says *Not checked*** — no Brave key saved, or the run never reached source tracing. **Trace** says which.
- **Trace shows *Source search* failed** — the Brave key is wrong, its plan lapsed, or the credit is gone. One `curl` to `https://api.search.brave.com/res/v1/web/search?q=test` with an `X-Subscription-Token` header tells you which.
- **Every *Source fetch* fails, with a Browserbase key set** — out of browser-hours, or the key is wrong. The free plan also allows only 3 browsers at once, and a paragraph with several claims can ask for more than that.
- **Sources are found but never verify, without a Browserbase key** — likely a site that renders its text with script, so the direct fetch saw an empty page. That is the case the Browserbase key exists for.

## What to try next

- A page with a **misleading statistic** — Inspector's framing flags are the point of the tool.
- A **checkout or signup page** — Application's dark-pattern band.
- A page with an **iframe** (an embedded payment form or video) — Security reads inside frames and attributes findings to the frame they came from.
- A `chrome://` page — every panel should tell you cleanly that browser pages are off-limits to extensions, rather than failing oddly.

## If something looks wrong

- **"No paragraph text found on this page."** — the page has no readable prose blocks, or it's still loading. Some app-shell sites genuinely have nothing to read.
- **A panel says "No OpenAI API key set."** — open Options and press **Test key**; the key may be rejected rather than missing.
- **Inspector shows "Not checked" for external sources** — expected until you add a Brave Search key ([§7](#7-optional-source-tracing)). It means nothing was checked, not that nothing was found.
- **Changes vanished after a reload** — rewrites and badges live in the page, so a reload clears them. The panel notices and updates rather than claiming they're still there.
