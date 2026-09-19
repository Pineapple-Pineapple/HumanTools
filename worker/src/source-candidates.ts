export interface RawSearchResult {
  url: string;
  title: string;
  description: string;
}

export interface CandidateSource {
  url: string;
  title: string;
  description: string;
  domainScore: number;
}

export type SourceContextReason = "page_context" | "non_factual_context";

const MAX_CANDIDATES = 5;
const TRACKING_PARAMETER = /^(utm_|fbclid$|gclid$|mc_[ce]id$)/i;
const NON_FACTUAL_DOMAINS = new Set(["theonion.com"]);

export function canonicalizeCandidateUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  url.hash = "";
  const keysToDelete: string[] = [];
  url.searchParams.forEach((_, key) => {
    if (TRACKING_PARAMETER.test(key)) keysToDelete.push(key);
  });
  for (const key of keysToDelete) {
    if (TRACKING_PARAMETER.test(key)) url.searchParams.delete(key);
  }
  return url.toString().replace(/\?$/, "");
}

/** Explains why an exact quote cannot serve as eligible external evidence. */
export function classifySourceContext(fetchedUrl: string, inspectedUrl: string): SourceContextReason[] {
  const fetched = canonicalizeCandidateUrl(fetchedUrl);
  const inspected = canonicalizeCandidateUrl(inspectedUrl);
  if (fetched === null) return [];

  const reasons: SourceContextReason[] = [];
  if (fetched === inspected) reasons.push("page_context");
  if (NON_FACTUAL_DOMAINS.has(new URL(fetched).hostname.replace(/^www\./, ""))) reasons.push("non_factual_context");
  return reasons;
}

function primarySourceScore(url: string): number {
  const host = new URL(url).hostname;
  if (host.endsWith(".gov")) return 300;
  if (host === "sec.gov" || host.endsWith(".sec.gov")) return 280;
  if (host === "doi.org" || host.endsWith(".doi.org")) return 220;
  if (/(?:\.edu|nature\.com|science\.org|thelancet\.com)$/i.test(host)) return 180;
  return 0;
}

export function rankCandidates(results: readonly RawSearchResult[]): CandidateSource[] {
  const unique = new Map<string, CandidateSource>();
  for (const result of results) {
    const url = canonicalizeCandidateUrl(result.url);
    if (!url || unique.has(url)) continue;
    unique.set(url, {
      url,
      title: result.title.trim(),
      description: result.description.trim(),
      domainScore: primarySourceScore(url),
    });
  }

  return [...unique.values()]
    .sort((left, right) => right.domainScore - left.domainScore)
    .slice(0, MAX_CANDIDATES);
}
