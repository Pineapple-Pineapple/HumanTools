/** A source that was fetched and found to carry the quote. */
export interface VerifiedSource {
  title: string;
  url: string;
  excerpt: string;
  publisher: string;
  verifiedAt: string;
  sourceQuality: SourceQuality;
}

export type SourceQuality = "institutional_signal" | "credibility_unassessed";

export interface SourceTraceRequest {
  claim: string;
  verifiedQuote: string;
  page: { url: string; title: string };
}
