# Removing the Source Tracer Worker

**Done — 2026-09-20.** Kept as the record of why, since the reasoning outlives the change.

## What the Worker was for

Source tracing needs a search API and a way to load arbitrary pages. Putting those credentials in a browser extension is normally the wrong call, so the pipeline lived in a Cloudflare Worker and the extension called it over HTTP.

## Why that stopped making sense

There was never a shared Human Tools service. Every install deployed **its own** Worker with **its own** keys — so the Worker was protecting the reader's credentials from the reader. Meanwhile the provider key, the one that can actually run up a bill, had been sitting in `chrome.storage.local` the whole time.

What the deployment step actually bought was nothing, and what it cost was the feature: it required a Cloudflare account, four secrets and a deploy before Inspector could check a single source, so in practice it never ran for anyone. Every card read "Not checked".

The principle is still right for a hosted service. It was the wrong shape for a bring-your-own-keys extension.

## What happened

Moved to `src/lib/tracer/`, unchanged: `brave-search.ts`, `browserbase-fetch.ts`, `source-candidates.ts`, `source-verify.ts`, `source-tracer-agent.ts`, and their 23 tests.

Deleted, because they existed only to serve an HTTP boundary:

- `source-tracer-do.ts` — the Durable Object, one per install, for routing and rate-limit state.
- `index.ts` — the `POST /v1/trace` endpoint.
- `trace-request.ts` — validation and size caps for a hostile request body. A local call has no untrusted caller.
- `rate-limit.ts` — 30 traces per 10 minutes per install, to stop a leaked URL draining the budget. There is no URL now, and the reader spends their own quota.
- `src/lib/source-tracer-client.ts` and its test — the NDJSON streaming client. With no wire, `traceSources` is a function call.

`src/lib/tracer/index.ts` is the new seam. `resolveTracerKeys` reads the keys; `traceSources` runs search → rank → fetch → verify and reports trace events through the same callback the panel already consumed.

## What changed for the reader

- Options swaps **Source Tracer endpoint** for **Brave Search API key** and **Browserbase API key**.
- Brave is required for tracing at all; without it, external verification reads "Not checked" exactly as before.
- **Browserbase became optional.** With a key, candidates open in its cloud browser, as before — script-rendered pages are read, and the reader's address never reaches them. Without one, the extension fetches the page directly: free and faster, but a script-rendered page arrives empty and fails to verify, and the site sees the reader's IP. Disclosed in the field's own hint.
- Rate limiting is gone, along with the endpoint that needed it.

## Left behind on existing installs

`chrome.storage.local` may still hold `sourceTracerUrl` and `sourceTracerInstallId` from an older build. Nothing reads them. A one-line `chrome.storage.local.remove([...])` on `runtime.onInstalled` would clear them if it ever seems worth it.
