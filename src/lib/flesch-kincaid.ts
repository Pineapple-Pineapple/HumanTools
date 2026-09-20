function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length === 0) return 0;
  const matches = w.match(/[aeiouy]+/g);
  let count = matches ? matches.length : 1;
  if (w.endsWith("e") && count > 1) count -= 1;
  return Math.max(1, count);
}

/** Excludes math notation and formula soup (e.g. scraped MathML) from being scored as prose. */
function isProseWord(token: string): boolean {
  const letters = token.match(/[a-zA-Z']/g)?.length ?? 0;
  return letters / token.length >= 0.6;
}

/**
 * Flesch-Kincaid grade level, computed locally with no network call. Null when there is no prose
 * to score — empty text, or nothing but math and symbols — rather than 0, which is the real grade
 * of very simple prose.
 */
export function computeFleschKincaidGrade(text: string): number | null {
  const proseWords = (s: string) => s.split(/\s+/).filter((w) => w.length > 0 && isProseWord(w));
  // A segment with no prose in it — a displayed equation between two full stops — is not a sentence.
  const sentences = text.split(/[.!?]+/).filter((s) => proseWords(s).length > 0);
  const words = proseWords(text);
  if (words.length === 0) return null;

  const syllables = words.reduce((sum, word) => sum + countSyllables(word), 0);
  const grade =
    0.39 * (words.length / sentences.length) + 11.8 * (syllables / words.length) - 15.59;

  return Math.max(0, Math.round(grade * 10) / 10);
}
