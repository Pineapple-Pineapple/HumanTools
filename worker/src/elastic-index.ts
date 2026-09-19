type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface VerifiedSource {
  title: string;
  url: string;
  excerpt: string;
  publisher: string;
  verifiedAt: string;
  sourceQuality: "institutional_signal" | "credibility_unassessed";
}

async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ElasticSourceIndex {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = (input, init) => globalThis.fetch(input, init),
  ) {}

  async index(source: VerifiedSource, verifiedQuote: string): Promise<void> {
    const documentId = await hash(`${source.url}\n${verifiedQuote}`);
    const url = `${this.baseUrl.replace(/\/$/, "")}/human-tools-sources/_doc/${documentId}`;
    const response = await this.fetcher(url, {
      method: "PUT",
      headers: { Authorization: `ApiKey ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        url: source.url,
        title: source.title,
        publisher: source.publisher,
        excerpt: source.excerpt,
        claimHash: await hash(verifiedQuote),
        sourceContentHash: await hash(source.excerpt),
        verifiedAt: source.verifiedAt,
        sourceQuality: source.sourceQuality,
        verification: "verified",
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Elastic indexing failed (${response.status}).`);
  }
}
