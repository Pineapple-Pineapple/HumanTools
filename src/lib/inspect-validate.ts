import { findVerifiedCore, normalizeWhitespace } from "./quote-match";
import type {
  ClaimCard,
  ClaimType,
  EvidenceStatus,
  FramingFlagKind,
  InspectTarget,
  OutlineLabel,
  PageLink,
  SlopReport,
} from "./types";

export const MAX_CLAIMS = 6;

const CLAIM_TYPES: readonly ClaimType[] = ["fact", "opinion", "speculation", "prediction", "quote"];
const STATUSES: readonly EvidenceStatus[] = ["supported", "partly_supported", "unverified", "contradicted"];
const FLAG_KINDS: readonly FramingFlagKind[] = [
  "base_effect",
  "cherry_picked_window",
  "missing_denominator",
  "relative_vs_absolute",
  "loaded_wording",
];
const OUTLINE_LABELS: readonly OutlineLabel[] = [
  "important",
  "supporting",
  "advertisement",
  "navigation",
  "boilerplate",
];

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

function prob(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined;
}

function isHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export interface ClaimValidation {
  claims: ClaimCard[];
  /** Claims dropped because their quote wasn't in the inspected text, or were malformed. */
  dropped: number;
  /** Claims whose non-"unverified" status had no page source behind it. */
  downgraded: number;
}

/**
 * The code-side verifier between the model and the card UI. It never trusts the model's shape:
 * every claim must quote text that really is in the inspected passage, sources can only be links
 * the page itself contains (referenced by index, so the model can't invent a URL), and any verdict
 * other than "unverified" needs at least one such source or it's downgraded — the unsourced read
 * is kept separately so the reader still sees it, labeled as such.
 */
export function validateClaims(raw: unknown, target: InspectTarget): ClaimValidation {
  const list = (raw as { claims?: unknown } | null)?.claims;
  if (!Array.isArray(list)) throw new Error("Response was missing a claims list.");

  const haystack = normalizeWhitespace(target.text).toLowerCase();
  const kept: { card: ClaimCard; pos: number }[] = [];
  let dropped = 0;
  let downgraded = 0;

  for (const item of list) {
    if (typeof item !== "object" || item === null) {
      dropped++;
      continue;
    }
    const r = item as Record<string, unknown>;
    const quote = str(r.quote);
    const claim = str(r.claim);
    const verifiedQuote = quote ? findVerifiedCore(haystack, quote) : null;
    if (!quote || !claim || !verifiedQuote) {
      dropped++;
      continue;
    }

    const framingFlags = Array.isArray(r.framingFlags)
      ? r.framingFlags.flatMap((f) => {
          const flag = f as Record<string, unknown> | null;
          const kind = oneOf(flag?.kind, FLAG_KINDS);
          const note = str(flag?.note);
          return kind && note ? [{ kind, note }] : [];
        })
      : [];

    const ev = (typeof r.evidence === "object" && r.evidence !== null ? r.evidence : {}) as Record<string, unknown>;
    const sources: PageLink[] = [];
    if (Array.isArray(ev.sourceLinks)) {
      for (const i of ev.sourceLinks) {
        if (!Number.isInteger(i) || i < 0 || i >= target.links.length) continue;
        const link = target.links[i];
        if (isHttpUrl(link.href) && !sources.some((s) => s.href === link.href)) sources.push(link);
      }
    }

    let status = oneOf(ev.status, STATUSES) ?? "unverified";
    let unsourcedAssessment: EvidenceStatus | undefined;
    if (status !== "unverified" && sources.length === 0) {
      unsourcedAssessment = status;
      status = "unverified";
      downgraded++;
    }

    kept.push({
      pos: haystack.indexOf(verifiedQuote),
      card: {
        claim,
        quote,
        verifiedQuote,
        type: oneOf(r.type, CLAIM_TYPES) ?? "fact",
        statedSource: str(r.statedSource),
        context: str(r.context),
        framingFlags,
        evidence: { status, sources, notChecked: str(ev.notChecked), unsourcedAssessment },
      },
    });
  }

  kept.sort((a, b) => a.pos - b.pos);
  const seen = new Set<string>();
  const claims: ClaimCard[] = [];
  for (const { card } of kept) {
    if (seen.has(card.verifiedQuote)) {
      dropped++;
      continue;
    }
    seen.add(card.verifiedQuote);
    claims.push(card);
  }

  if (claims.length > MAX_CLAIMS) dropped += claims.length - MAX_CLAIMS;
  return { claims: claims.slice(0, MAX_CLAIMS), dropped, downgraded };
}

/** Parses GPTZero's /v2/predict/text response into a SlopReport. */
export function parseSlopResponse(data: unknown): SlopReport {
  const doc = (data as { documents?: unknown[] } | null)?.documents?.[0] as Record<string, unknown> | undefined;
  if (!doc) throw new Error("GPTZero returned no document result.");

  const probs = (typeof doc.class_probabilities === "object" && doc.class_probabilities !== null
    ? doc.class_probabilities
    : {}) as Record<string, unknown>;
  const aiProbability = prob(probs.ai) ?? prob(doc.completely_generated_prob);
  if (aiProbability === undefined) throw new Error("GPTZero response had no AI probability.");

  const sentences = Array.isArray(doc.sentences)
    ? doc.sentences.flatMap((s) => {
        const row = s as Record<string, unknown> | null;
        const text = str(row?.sentence);
        const p = prob(row?.generated_prob);
        return text && p !== undefined ? [{ text, aiProbability: p }] : [];
      })
    : [];

  return {
    aiProbability,
    mixedProbability: prob(probs.mixed),
    humanProbability: prob(probs.human),
    // Reported as GPTZero's read, so nothing here invents a class it did not give.
    predictedClass: str(doc.predicted_class) ?? "unknown",
    confidence: str(doc.confidence_category) ?? "unknown",
    message: str(doc.result_message),
    sentences,
  };
}

/** Keeps only labels for known block ids with an allowed label value. */
export function parseOutlineLabels(raw: unknown, knownIds: ReadonlySet<string>): Map<string, OutlineLabel> {
  const list = (raw as { labels?: unknown } | null)?.labels;
  if (!Array.isArray(list)) throw new Error("Response was missing a labels list.");
  const labels = new Map<string, OutlineLabel>();
  for (const item of list) {
    const r = item as Record<string, unknown> | null;
    const id = str(r?.id);
    const label = oneOf(r?.label, OUTLINE_LABELS);
    if (id && label && knownIds.has(id)) labels.set(id, label);
  }
  return labels;
}
