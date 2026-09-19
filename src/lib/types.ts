export interface Block {
  id: string;
  text: string;
}

export interface PageLink {
  href: string;
  text: string;
}

export interface PageModel {
  url: string;
  blocks: Block[];
  links: PageLink[];
}

export type Grade = 6 | 8 | 10 | 12;

export type Provider = "openai" | "openrouter";

export type RewriteFormat = "prose" | "bullets";

/** What the reader picked or selected for the Inspector, captured by the content script. */
export interface InspectTarget {
  /** The selected text (or the whole picked paragraph). */
  text: string;
  /** The containing paragraph, for context around a partial selection. */
  paragraph: string;
  /** `data-ht-inspect-id` of the containing block, used to place markers on the page. */
  blockId: string | null;
  url: string;
  title: string;
  publishedAt?: string;
  /** Outbound http(s) links inside the selection's paragraph. */
  links: PageLink[];
}

export type ClaimType = "fact" | "opinion" | "speculation" | "prediction" | "quote";

export type EvidenceStatus = "supported" | "partly_supported" | "unverified" | "contradicted";

export type FramingFlagKind =
  | "base_effect"
  | "cherry_picked_window"
  | "missing_denominator"
  | "relative_vs_absolute"
  | "loaded_wording";

export interface ClaimCard {
  claim: string;
  /** Verbatim span from the inspected text, as the model quoted it. */
  quote: string;
  /** The part of `quote` verified to exist in the inspected text (normalized, lowercase). */
  verifiedQuote: string;
  type: ClaimType;
  statedSource?: string;
  context?: string;
  framingFlags: { kind: FramingFlagKind; note: string }[];
  evidence: {
    status: EvidenceStatus;
    sources: PageLink[];
    notChecked?: string;
    /** Set when the verifier downgraded the model's status for lack of a source. */
    unsourcedAssessment?: EvidenceStatus;
  };
}

/** GPTZero's read on a passage — a probability, never proof of authorship. */
export interface SlopReport {
  aiProbability: number;
  mixedProbability?: number;
  humanProbability?: number;
  predictedClass: string;
  confidence: string;
  message?: string;
  sentences: { text: string; aiProbability: number }[];
}

export type OutlineLabel = "important" | "supporting" | "advertisement" | "navigation" | "boilerplate";

export interface OutlineBlock {
  /** `data-ht-outline-id` on the page element. */
  id: string;
  /** Lowercase tag name, e.g. "h2", "p", "nav". */
  tag: string;
  /** Tree depth: headings nest by level, other blocks sit one level under the last heading. */
  depth: number;
  text: string;
  label: OutlineLabel;
  /** Whether the label came from DOM signals alone (nav/ads) and shouldn't be re-labeled. */
  fixed: boolean;
}
