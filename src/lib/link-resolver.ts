/**
 * Following a link to see where it lands — the second thing about a page that cannot be answered
 * by reading the page.
 *
 * This is the more consequential of the panel's two network buttons, and the code is shaped around
 * saying so. Requesting a link contacts the destination server from the reader's own address. For a
 * tracking shortener that is close to indistinguishable from clicking it; on a link built to catch
 * someone, it tells whoever runs it that this link is being looked at. So nothing here runs during
 * a scan, one press resolves one link, and the disclosure is written before the button.
 *
 * Only the final address is reported. `redirect: "manual"` returns an opaque response in this
 * context — the intermediate Location headers are not readable — so a hop-by-hop chain would have
 * to be invented, and an invented chain is worse than no chain. The wording says which one this is.
 *
 * Fetching is split from shaping: describeDestination is pure, so the reporting is tested without
 * a network call.
 */

import { effectiveDomain, hasPunycodeLabel, hostFromLinkText, isUrlShortener } from "./security-heuristics";
import type { LinkSignal, SecuritySignals } from "./security-heuristics";

export const RESOLVE_TIMEOUT_MS = 10_000;

/** Only what the resolver reads off a response, so a test can hand it a plain object. */
export interface FetchedResponse {
  url: string;
  status: number;
}

export type ResolverFetch = (url: string, init: RequestInit) => Promise<FetchedResponse>;

export type LinkResolution =
  | {
      state: "resolved";
      requested: string;
      final: string;
      httpStatus: number;
      method: "HEAD" | "GET";
      /** The final address is on a different registered name than the link itself. */
      movedSite: boolean;
      /** Nothing redirected: the link ends exactly where it points. */
      sameUrl: boolean;
    }
  | { state: "failed"; requested: string; detail: string }
  | { state: "not_a_web_url"; requested: string };

// ---- Which links are worth offering to follow ---------------------------------------------------

export type FlagReason = "text_mismatch" | "punycode" | "shortener";

export interface FlaggedLink {
  href: string;
  hostname: string;
  text: string;
  reason: FlagReason;
  reasonLabel: string;
  /** "" for the top document; the frame's own address otherwise. */
  frameUrl: string;
}

const REASON_LABEL: Record<FlagReason, string> = {
  text_mismatch: "shows one address, points at another",
  punycode: "encoded internationalized hostname",
  shortener: "shortening service",
};

/** Worst-first, so a link flagged for two reasons is offered under the one that matters more. */
const REASON_RANK: Record<FlagReason, number> = { text_mismatch: 0, punycode: 1, shortener: 2 };

function reasonFor(link: LinkSignal): FlagReason | null {
  const host = link.hostname.toLowerCase();
  if (!host) return null;
  const claimed = hostFromLinkText(link.text);
  if (claimed && effectiveDomain(claimed) !== effectiveDomain(host)) return "text_mismatch";
  if (hasPunycodeLabel(host)) return "punycode";
  if (isUrlShortener(host)) return "shortener";
  return null;
}

/**
 * The links the scan already had something to say about: a destination the text disagrees with, an
 * encoded name, or a shortener. Only these get a button — a page's other four hundred links are not
 * something a reader should be invited to fire requests at one at a time.
 */
export function resolvableLinks(signals: SecuritySignals, frames: readonly SecuritySignals[] = []): FlaggedLink[] {
  const documents: { signals: SecuritySignals; frameUrl: string }[] = [
    { signals, frameUrl: "" },
    ...frames.map((frame) => ({ signals: frame, frameUrl: frame.url })),
  ];

  const byHref = new Map<string, FlaggedLink>();
  for (const document of documents) {
    for (const link of document.signals.links) {
      if (link.protocol !== "http:" && link.protocol !== "https:") continue;
      const reason = reasonFor(link);
      if (!reason) continue;
      const existing = byHref.get(link.href);
      if (existing && REASON_RANK[existing.reason] <= REASON_RANK[reason]) continue;
      byHref.set(link.href, {
        href: link.href,
        hostname: link.hostname.toLowerCase(),
        text: link.text,
        reason,
        reasonLabel: REASON_LABEL[reason],
        frameUrl: document.frameUrl,
      });
    }
  }

  return [...byHref.values()].sort((a, b) => REASON_RANK[a.reason] - REASON_RANK[b.reason]);
}

// ---- Following one ------------------------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isWebUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Shapes one completed request into a result. Pure: the network part is the caller's problem. */
export function describeDestination(requested: string, finalUrl: string, httpStatus: number, method: "HEAD" | "GET"): LinkResolution {
  const final = finalUrl || requested;
  return {
    state: "resolved",
    requested,
    final,
    httpStatus,
    method,
    movedSite: effectiveDomain(hostOf(final)) !== effectiveDomain(hostOf(requested)),
    sameUrl: final === requested,
  };
}

function failureDetail(err: unknown, timeoutMs: number): string {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return `nothing came back within ${Math.round(timeoutMs / 1000)} seconds`;
  }
  if (err instanceof DOMException && err.name === "AbortError") return "the request was stopped";
  const message = err instanceof Error ? err.message : String(err);
  return message ? `the request failed (${message})` : "the request failed";
}

/** Statuses that usually mean "not that verb" rather than "not that page", so GET is worth a try. */
const METHOD_REJECTED = new Set([400, 403, 405, 501]);

/**
 * Follows one link and reports where it stopped. HEAD first — it asks for headers and no body, so a
 * phishing page is not downloaded — with GET as the fallback for servers that refuse HEAD outright.
 * Cookies and referrer are withheld; the request carries the address and nothing about this page.
 */
export async function resolveLink(
  href: string,
  options: { fetchImpl?: ResolverFetch; timeoutMs?: number } = {},
): Promise<LinkResolution> {
  if (!isWebUrl(href)) return { state: "not_a_web_url", requested: href };

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as ResolverFetch);
  const timeoutMs = options.timeoutMs ?? RESOLVE_TIMEOUT_MS;
  const init = (method: "HEAD" | "GET"): RequestInit => ({
    method,
    redirect: "follow",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });

  let headFailure: string | null = null;
  try {
    const response = await fetchImpl(href, init("HEAD"));
    if (!METHOD_REJECTED.has(response.status)) return describeDestination(href, response.url, response.status, "HEAD");
    headFailure = `the server answered ${response.status} to a HEAD request`;
  } catch (err) {
    headFailure = failureDetail(err, timeoutMs);
  }

  try {
    const response = await fetchImpl(href, init("GET"));
    return describeDestination(href, response.url, response.status, "GET");
  } catch (err) {
    return { state: "failed", requested: href, detail: `${headFailure}, and then ${failureDetail(err, timeoutMs)}` };
  }
}

// ---- Wording -------------------------------------------------------------------------------------
// The consequence of pressing the button, written before the button, and the attribution written
// after it. Both live here so the tests that police this panel's refusal to issue a verdict cover
// the network results too.

export const RESOLVE_DISCLOSURE =
  "Pressing one of these asks that address for the link from your own IP address, following redirects — once for the headers, and a second time for the page itself if that server refuses the first. No cookies and no referring page are sent, but the requests are real: on a tracking shortener this is close to indistinguishable from clicking the link and may count as a visit, and on a link built to catch someone it tells whoever runs it that this link is being looked at, and roughly from where. Only the address it finally lands on comes back — the hops in between cannot be read from here.";

/** The one-line version under each button, naming the host that specific press contacts. */
export function resolveDisclosure(href: string): string {
  const host = hostOf(href);
  return host ? `Contacts ${host} directly from your IP address.` : "Contacts this address directly from your IP address.";
}

export const RESOLVE_ATTRIBUTION =
  "This came from a request made just now over the network, not from the page. It is where the link went at this moment; a link that decides its destination per visitor can send someone else somewhere else.";

export function destinationSentence(resolution: LinkResolution): string {
  if (resolution.state === "not_a_web_url") {
    return `${resolution.requested} is not an http or https address, so there is nothing to follow.`;
  }
  if (resolution.state === "failed") {
    return `The request did not complete: ${resolution.detail}. Servers routinely refuse requests that do not come from an ordinary tab, so this is a fact about the request, not about where the link goes.`;
  }
  const status = `HTTP ${resolution.httpStatus} to a ${resolution.method} request.`;
  if (resolution.sameUrl) {
    return `It ends where it points: ${resolution.final}. Nothing redirected. ${status}`;
  }
  if (resolution.movedSite) {
    return `It ends at ${resolution.final} — ${effectiveDomain(hostOf(resolution.final)) || "an address"}, a different registered name from ${effectiveDomain(hostOf(resolution.requested)) || "the link"}. ${status}`;
  }
  return `It ends at ${resolution.final}, still on ${effectiveDomain(hostOf(resolution.final)) || "the same name"}. ${status}`;
}
