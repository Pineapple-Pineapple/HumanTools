# Removing the Source Tracer Worker

A standing note, written while removing Elastic, so that dropping the Worker later is a decision rather than an investigation. Nothing here is done; this is the map.

## What it would cost

Inspector loses **external source verification** — the step that goes out and checks whether a claim's quote appears anywhere off the page. Everything else in Inspector survives untouched: claim extraction, claim types, evidence statuses, framing flags, page-cited links, page-context classification, Slop Check, Outline, and the numbered page badges.

The case for going ahead is that **it has never run for anyone.** It has always required deploying your own Cloudflare Worker, so every Inspector card in every install reads "Not checked". Removing it would delete roughly 2,300 lines that have never executed outside tests, drop two vendor accounts from setup, and let the README, the getting-started guide and the Options page stop explaining a feature nobody has.

The case against is that it works — it just needs deploying — and it is the part of the product that most supports the "evidence, not verdicts" claim. Without it, Inspector reports what a page says about itself and no more.

## What to delete

**The whole `worker/` directory** — 20 files, ~1,800 lines, its own `package.json`, `wrangler.jsonc`, and the `test:worker` script in the root `package.json`.

**Extension-side client**

- `src/lib/source-tracer-client.ts` and `test/source-tracer-client.test.ts`

**Extension wiring** (edit, don't delete)

| File | What goes |
| --- | --- |
| `src/background/service-worker.ts` | `runSourceTracer`, `sourceCache`, the `requestSourceTrace` import, `NO_TRACER_ENDPOINT`, and the `sourceTracerInstallId` storage read. `handleInspectRequest` stops posting `INSPECT_SOURCES`. |
| `src/lib/messages.ts` | The `InspectSources` message and its entry in `InspectMessage`/`InspectHandlers`. |
| `src/lib/provider.ts` | `getSourceTracerUrl`. |
| `src/sidepanel/inspector-panel.ts` | The "External verification" and "Page context — not verification" sections, `renderVerifiedSources`, `renderAllSources`, `noExternalSourcesMessage`, `sourceContextMessage`, `sourceQualityMessage`, `tracerConfigured`, and `SavedInspection.sources`. |
| `src/options/options.ts` | The `sourceTracerUrl` field, its https guard, and its help text. |
| `test/inspector-source-context.test.ts` | Tests `sourceContextMessage` / `sourceQualityMessage` / `noExternalSourcesMessage` — all three disappear with the sections above. |

**Docs**

- `README.md` — the "Source Tracer Worker (optional)" section, the Inspector paragraph's mention of it, and the row in the privacy list.
- `GETTING-STARTED.md` — section 7 in full, the Source Tracer line in step 3, and the "Not checked" entry under "If something looks wrong".
- `docs/superpowers/` — the two `inspector-source-tracer` and two `inspector-source-context` files become history for a feature that no longer exists. Either delete them or leave them as an archive; the README already says these docs are point-in-time and diverge from the code.

## Two things to get right

**The honesty wording has to go with it, not linger.** Inspector currently distinguishes "Not checked" (no tracer configured) from "No external verification found" (checked, found nothing) — that distinction was a deliberate fix and only makes sense while a tracer can exist. With the Worker gone, both strings should go; a claim card should simply not have an external-verification section rather than carry a permanently empty one.

**`chrome.storage.local` keeps `sourceTracerUrl` and `sourceTracerInstallId` on existing installs.** Neither is read after the removal, so they are harmless, but a one-line `chrome.storage.local.remove([...])` on `runtime.onInstalled` would leave nothing behind.

## Order

1. Strip the extension wiring first (panel → messages → service worker → options) and confirm `npx tsc --noEmit` is clean — the compiler will find every reference.
2. Delete `worker/`, the client, and their tests.
3. Update the docs.
4. `bun run test` and `bun run build`; drop `test:worker` from the root scripts.

## What survives either way

Brave Search and Browserbase are used **only** by the Worker, so both accounts become unnecessary. GPTZero is not — it is called directly from the extension's service worker for Slop Check and is unaffected. The provider key (OpenAI or OpenRouter) is likewise untouched.
