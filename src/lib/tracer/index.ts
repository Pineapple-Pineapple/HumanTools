import { BraveSearchClient, searchQuery } from "./brave-search";
import { BrowserbaseFetcher } from "./browserbase-fetch";
import { rankCandidates } from "./source-candidates";
import { makeSourceTracer } from "./source-tracer-agent";
import type { SourceTraceEvent, SourceTraceOutcome } from "./source-tracer-agent";

export type { SourceTraceEvent, SourceTraceOutcome, TracedSource, ContextSource } from "./source-tracer-agent";
export type { SourceContextReason } from "./source-candidates";
export type { VerifiedSource, SourceQuality } from "./types";

/** Where each tracer key lives in `chrome.storage.local`; the options page writes these. */
export const TRACER_KEY_NAMES = { brave: "braveSearchApiKey", browserbase: "browserbaseApiKey" } as const;
export const TRACER_STORAGE_KEYS = Object.values(TRACER_KEY_NAMES);

export const NO_SEARCH_KEY = "No Brave Search API key set.";

export interface TracerKeys {
  brave: string;
  browserbase: string | null;
}

/**
 * The keys source tracing needs, or null when it can't run at all. Brave is required — without a
 * way to find candidates there is nothing to check. Browserbase is optional: without it, candidate
 * pages are fetched directly, which is faster and free but sees only server-rendered text.
 */
export async function resolveTracerKeys(stored: Record<string, unknown>): Promise<TracerKeys | null> {
  const brave = stored[TRACER_KEY_NAMES.brave];
  if (typeof brave !== "string" || !brave) return null;
  const browserbase = stored[TRACER_KEY_NAMES.browserbase];
  return { brave, browserbase: typeof browserbase === "string" && browserbase ? browserbase : null };
}

/**
 * Reads a candidate page directly, for installs with no Browserbase key. A page that renders its
 * text with script comes back as an empty shell, which simply fails to verify — the honest
 * outcome, and the reason the option is disclosed rather than silently substituted.
 */
async function fetchDocument(url: string, signal: AbortSignal): Promise<{ title: string; url: string; text: string }> {
  const response = await fetch(url, { redirect: "follow", credentials: "omit", referrerPolicy: "no-referrer", signal });
  if (!response.ok) throw new Error(`Source fetch failed (${response.status}).`);
  const html = await response.text();
  // No DOMParser in a service worker: strip script and style wholesale, then all remaining tags.
  const stripped = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? response.url;
  return { title, url: response.url, text: stripped.replace(/\s+/g, " ").trim() };
}

/**
 * Finds and checks external sources for one claim, in the extension itself. This used to be a
 * Cloudflare Worker the reader had to deploy: it held the credentials so they never sat in a
 * browser. That protected a shared service which never existed — every install deployed its own,
 * with its own keys — so the deployment step bought nothing and stopped the feature from ever
 * running. The keys now sit beside the provider key they always could have.
 */
export async function traceSources(
  keys: TracerKeys,
  request: { claim: string; verifiedQuote: string; page: { url: string; title: string } },
  onTrace: (event: SourceTraceEvent) => void,
  signal: AbortSignal,
): Promise<SourceTraceOutcome> {
  const search = new BraveSearchClient(keys.brave);
  const browserbase = keys.browserbase ? new BrowserbaseFetcher({ apiKey: keys.browserbase }) : null;

  const tracer = makeSourceTracer({
    search: async (input) => rankCandidates(await search.search(searchQuery(input.claim, input.verifiedQuote), signal)),
    fetch: (candidate) =>
      browserbase ? browserbase.fetch(candidate) : fetchDocument(candidate.url, signal),
  });

  return tracer.trace(request, onTrace);
}
