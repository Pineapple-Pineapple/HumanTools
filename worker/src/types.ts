export interface Env {
  SOURCE_TRACER: DurableObjectNamespace;
  BRAVE_SEARCH_API_KEY: string;
  BROWSERBASE_API_KEY: string;
  /** Optional wrangler vars; see rate-limit.ts for the defaults they override. */
  TRACE_RATE_LIMIT?: string;
  TRACE_RATE_WINDOW_SECONDS?: string;
}

/** A source that was fetched and found to carry the quote. */
export interface VerifiedSource {
  title: string;
  url: string;
  excerpt: string;
  publisher: string;
  verifiedAt: string;
  sourceQuality: "institutional_signal" | "credibility_unassessed";
}

export interface SourceTraceRequest {
  claim: string;
  verifiedQuote: string;
  page: { url: string; title: string };
  installId: string;
}
