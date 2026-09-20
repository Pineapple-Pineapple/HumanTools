type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface VerifiedSource {
  title: string;
  url: string;
  excerpt: string;
  publisher: string;
  verifiedAt: string;
  sourceQuality: "institutional_signal" | "credibility_unassessed";
}

/**
 * A source the index already holds. `exact` means this excerpt was verified against the very same
 * quote before, so it can stand as evidence again without another fetch. Anything else is a lead:
 * the index thinks this source is about the same subject, which is a reason to look, never proof.
 */
export interface RecalledSource {
  source: VerifiedSource;
  exact: boolean;
  score: number;
}

export interface ElasticOptions {
  /** Elastic Cloud ships this endpoint by default; both are overridable for self-managed clusters. */
  embeddingInferenceId?: string;
  rerankInferenceId?: string;
}

const INDEX = "human-tools-sources";
const DEFAULT_EMBEDDING_INFERENCE_ID = ".elser-2-elasticsearch";
const DEFAULT_RERANK_INFERENCE_ID = ".rerank-v1-elasticsearch";
const REQUEST_TIMEOUT_MS = 5_000;
const RECALL_SIZE = 5;
const RANK_WINDOW_SIZE = 50;

/**
 * The index mapping. `excerpt` stays a plain text field so BM25 scores the reader's own words, and
 * `excerptSemantic` is the same text handed to Elastic's inference endpoint — the embedding is made
 * on the cluster, so no vector ever has to be computed in the Worker.
 */
const MAPPING = {
  mappings: {
    properties: {
      url: { type: "keyword" },
      title: { type: "text" },
      publisher: { type: "keyword" },
      excerpt: { type: "text" },
      claimHash: { type: "keyword" },
      sourceContentHash: { type: "keyword" },
      verifiedAt: { type: "date" },
      sourceQuality: { type: "keyword" },
      verification: { type: "keyword" },
    },
  },
} as const;

interface SearchHit {
  _score?: number;
  _source?: Partial<VerifiedSource> & { claimHash?: string };
}

interface SearchResponse {
  hits?: { hits?: SearchHit[] };
}

async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isVerifiedSource(value: SearchHit["_source"]): value is VerifiedSource & { claimHash?: string } {
  return (
    typeof value?.url === "string" &&
    typeof value.title === "string" &&
    typeof value.excerpt === "string" &&
    typeof value.publisher === "string" &&
    typeof value.verifiedAt === "string"
  );
}

export class ElasticSourceIndex {
  private readonly embeddingInferenceId: string;
  private readonly rerankInferenceId: string;
  /** Memoised so a hot Durable Object pays for the mapping check once, not once per trace. */
  private prepared?: Promise<void>;
  /** Flipped when the cluster rejects a reranked search, so later searches stop paying for it. */
  private rerankerUnavailable = false;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = (input, init) => globalThis.fetch(input, init),
    options: ElasticOptions = {},
  ) {
    this.embeddingInferenceId = options.embeddingInferenceId ?? DEFAULT_EMBEDDING_INFERENCE_ID;
    this.rerankInferenceId = options.rerankInferenceId ?? DEFAULT_RERANK_INFERENCE_ID;
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}/${path}`;
  }

  private request(path: string, method: string, body: unknown): Promise<Response> {
    return this.fetcher(this.url(path), {
      method,
      headers: { Authorization: `ApiKey ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /**
   * Creates the index if it is not there yet. A cluster that already has it answers 400 with
   * `resource_already_exists_exception`, which is the success case on every run after the first.
   */
  async ensureIndex(): Promise<void> {
    this.prepared ??= (async () => {
      const response = await this.request(INDEX, "PUT", {
        mappings: {
          properties: {
            ...MAPPING.mappings.properties,
            excerptSemantic: { type: "semantic_text", inference_id: this.embeddingInferenceId },
          },
        },
      });
      if (response.ok) return;
      const detail = await response.text().catch(() => "");
      if (response.status === 400 && detail.includes("resource_already_exists_exception")) return;
      throw new Error(`Elastic index setup failed (${response.status}).`);
    })().catch((error: unknown) => {
      // A failed setup must not poison every later trace: let the next call try again.
      this.prepared = undefined;
      throw error;
    });
    return this.prepared;
  }

  async index(source: VerifiedSource, verifiedQuote: string): Promise<void> {
    await this.ensureIndex();
    const documentId = await hash(`${source.url}\n${verifiedQuote}`);
    const response = await this.request(`${INDEX}/_doc/${documentId}`, "PUT", {
      url: source.url,
      title: source.title,
      publisher: source.publisher,
      excerpt: source.excerpt,
      // The same text again, for the field whose embedding the cluster computes on ingest.
      excerptSemantic: source.excerpt,
      claimHash: await hash(verifiedQuote),
      sourceContentHash: await hash(source.excerpt),
      verifiedAt: source.verifiedAt,
      sourceQuality: source.sourceQuality,
      verification: "verified",
    });
    if (!response.ok) throw new Error(`Elastic indexing failed (${response.status}).`);
  }

  /**
   * Hybrid retrieval: BM25 over the excerpt the reader would recognise, semantic retrieval over the
   * same text, the two combined with reciprocal rank fusion, then reranked against the claim. The
   * reranker is the one part a self-managed cluster may not have, so a rejection drops it and the
   * fused results stand on their own rather than the whole recall failing.
   */
  async search(claim: string, verifiedQuote: string): Promise<RecalledSource[]> {
    await this.ensureIndex();
    const claimHash = await hash(verifiedQuote);

    let response = await this.request(`${INDEX}/_search`, "POST", this.searchBody(claim, verifiedQuote, !this.rerankerUnavailable));
    if (!response.ok && !this.rerankerUnavailable) {
      this.rerankerUnavailable = true;
      response = await this.request(`${INDEX}/_search`, "POST", this.searchBody(claim, verifiedQuote, false));
    }
    if (!response.ok) throw new Error(`Elastic search failed (${response.status}).`);

    const body = (await response.json()) as SearchResponse;
    const hits = body.hits?.hits ?? [];
    return hits.flatMap((hit) => {
      if (!isVerifiedSource(hit._source)) return [];
      const { claimHash: hitClaimHash, ...source } = hit._source;
      return [{
        source: {
          title: source.title,
          url: source.url,
          excerpt: source.excerpt,
          publisher: source.publisher,
          verifiedAt: source.verifiedAt,
          sourceQuality: source.sourceQuality ?? "credibility_unassessed",
        },
        exact: hitClaimHash === claimHash,
        score: hit._score ?? 0,
      }];
    });
  }

  private searchBody(claim: string, verifiedQuote: string, rerank: boolean): Record<string, unknown> {
    const fused = {
      rrf: {
        retrievers: [
          {
            standard: {
              query: {
                multi_match: {
                  query: `${claim} ${verifiedQuote}`.trim(),
                  fields: ["excerpt^2", "title"],
                },
              },
            },
          },
          {
            standard: {
              query: { semantic: { field: "excerptSemantic", query: claim } },
            },
          },
        ],
        rank_window_size: RANK_WINDOW_SIZE,
      },
    };

    return {
      retriever: rerank
        ? {
            text_similarity_reranker: {
              retriever: fused,
              field: "excerpt",
              inference_id: this.rerankInferenceId,
              inference_text: claim,
              rank_window_size: RECALL_SIZE * 2,
            },
          }
        : fused,
      size: RECALL_SIZE,
      _source: ["url", "title", "publisher", "excerpt", "verifiedAt", "sourceQuality", "claimHash"],
    };
  }
}
