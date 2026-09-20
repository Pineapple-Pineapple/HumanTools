import type { RawSearchResult } from "./source-candidates";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class SearchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchUnavailableError";
  }
}

function parseResults(payload: unknown): RawSearchResult[] {
  const rows = (payload as { web?: { results?: unknown } } | null)?.web?.results;
  if (!Array.isArray(rows)) throw new SearchUnavailableError("Brave returned an invalid search response.");

  return rows.flatMap((row) => {
    const result = row as Record<string, unknown>;
    return typeof result.url === "string" && typeof result.title === "string"
      ? [{ url: result.url, title: result.title, description: typeof result.description === "string" ? result.description : "" }]
      : [];
  });
}

/** Brave rejects a query over 400 characters or 50 words. */
const MAX_QUERY_CHARS = 400;
const MAX_QUERY_WORDS = 50;

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function compose(claim: readonly string[], quote: readonly string[]): string {
  return `${claim.join(" ")} ${quote.length ? `"${quote.join(" ")}"` : ""}`.trim();
}

/**
 * The exact phrase is what finds the page; the claim only adds context. When the pair exceeds
 * Brave's limits the claim is shortened first, then the quote, always on word boundaries.
 */
export function searchQuery(claim: string, verifiedQuote: string): string {
  const quote = words(verifiedQuote);
  const claimWords = words(claim);
  let quoteCount = Math.min(quote.length, MAX_QUERY_WORDS);
  while (quoteCount > 0 && compose([], quote.slice(0, quoteCount)).length > MAX_QUERY_CHARS) quoteCount--;
  let claimCount = Math.min(claimWords.length, MAX_QUERY_WORDS - quoteCount);
  while (claimCount > 0 && compose(claimWords.slice(0, claimCount), quote.slice(0, quoteCount)).length > MAX_QUERY_CHARS) claimCount--;
  return compose(claimWords.slice(0, claimCount), quote.slice(0, quoteCount));
}

export class BraveSearchClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = (input, init) => globalThis.fetch(input, init),
  ) {}

  async search(query: string, signal: AbortSignal = AbortSignal.timeout(8_000)): Promise<RawSearchResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.search = new URLSearchParams({ q: query, count: "10" }).toString();
    const response = await this.fetcher(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": this.apiKey },
      signal,
    });
    if (!response.ok) throw new SearchUnavailableError(`Brave search failed (${response.status}).`);

    try {
      return parseResults(await response.json());
    } catch (error) {
      if (error instanceof SearchUnavailableError) throw error;
      throw new SearchUnavailableError("Brave returned invalid JSON.");
    }
  }
}
