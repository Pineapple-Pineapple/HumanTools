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

export class BraveSearchClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = fetch,
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
