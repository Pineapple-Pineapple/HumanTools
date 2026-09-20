export interface Env {
  SOURCE_TRACER: DurableObjectNamespace;
  BRAVE_SEARCH_API_KEY: string;
  BROWSERBASE_API_KEY: string;
  ELASTIC_URL: string;
  ELASTIC_API_KEY: string;
  /** Optional wrangler vars; see rate-limit.ts for the defaults they override. */
  TRACE_RATE_LIMIT?: string;
  TRACE_RATE_WINDOW_SECONDS?: string;
}

export interface SourceTraceRequest {
  claim: string;
  verifiedQuote: string;
  page: { url: string; title: string };
  installId: string;
}
