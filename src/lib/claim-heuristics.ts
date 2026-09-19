import { normalizeWhitespace } from "./quote-match";
import type { ClaimType } from "./types";

/** Splits prose into sentences; requires a capital or quote after the break so "3.5%" stays whole. */
export function splitSentences(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?]["”’)]?)\s+(?=["“(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const QUOTE_RE = /["“][^"”]{8,}["”]|\b(said|says|told|according to|wrote|stated)\b/i;
const PREDICTION_RE =
  /\b(will|is expected to|are expected to|forecasts?|projected|is set to|are set to|by (19|20)\d\d|next (year|decade|quarter))\b/i;
const SPECULATION_RE = /\b(may|might|could|possibly|perhaps|likely|unlikely|suggests?|appears? to|seems? to|reportedly)\b/i;
const OPINION_RE =
  /\b(should|must|ought to|best|worst|great|terrible|clearly|obviously|unfortunately|fortunately|I think|we believe|in my view|arguably)\b/i;

/**
 * A fast, local first guess at a sentence's claim type — shown instantly while the model's
 * claim extraction runs, then replaced by it. Deliberately simple: word cues, checked in order
 * of how strongly they override a plain statement of fact.
 */
export function heuristicClaimType(sentence: string): ClaimType {
  if (QUOTE_RE.test(sentence)) return "quote";
  if (PREDICTION_RE.test(sentence)) return "prediction";
  if (SPECULATION_RE.test(sentence)) return "speculation";
  if (OPINION_RE.test(sentence)) return "opinion";
  return "fact";
}
