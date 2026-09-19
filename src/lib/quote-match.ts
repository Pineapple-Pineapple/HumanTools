export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Below this, a plain "quoted" span is more likely an incidental short quote than a citation. */
export const MIN_QUOTE_CANDIDATE_WORDS = 6;

/**
 * Returns the verbatim substring of `haystackNormalized` (whitespace-normalized, lowercased)
 * that verifies `quote` — either the whole normalized quote, or its core with a few boundary
 * words trimmed — or null if it can't be verified at all. Models often lightly trim a quote's
 * edges — dropping a leading connector clause, adjusting trailing punctuation — while keeping
 * the rest character-for-character; requiring an exact whole-string match would reject those
 * even though the substance is a real quote. Trimming is capped so this still can't wave
 * through a paraphrase: most of the quote's words must survive intact and contiguous. The
 * returned substring (rather than a boolean) is what gets searched for on the live page, since
 * the model's untrimmed quote may include words that were never actually adjacent there.
 */
export function findVerifiedCore(haystackNormalized: string, quote: string): string | null {
  const words = normalizeWhitespace(quote).toLowerCase().split(" ").filter(Boolean);
  if (words.length === 0) return null;
  const full = words.join(" ");
  if (haystackNormalized.includes(full)) return full;

  const MAX_TRIM = 4;
  for (let trimStart = 0; trimStart <= MAX_TRIM; trimStart++) {
    for (let trimEnd = 0; trimEnd <= MAX_TRIM; trimEnd++) {
      if (trimStart === 0 && trimEnd === 0) continue;
      const core = words.slice(trimStart, words.length - trimEnd);
      if (core.length < MIN_QUOTE_CANDIDATE_WORDS || core.length < words.length * 0.6) continue;
      const coreText = core.join(" ");
      if (haystackNormalized.includes(coreText)) return coreText;
    }
  }
  return null;
}
