export interface Env {
  BRAVE_SEARCH_API_KEY: string;
  BROWSERBASE_API_KEY: string;
  BROWSERBASE_PROJECT_ID: string;
  ELASTIC_URL: string;
  ELASTIC_API_KEY: string;
}

export interface SourceTraceRequest {
  claim: string;
  verifiedQuote: string;
  page: { url: string; title: string };
  installId: string;
}
