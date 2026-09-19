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

/** Flesch-Kincaid grade level, computed locally with no network call. */
export function computeFleschKincaidGrade(text: string): number {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const words = text
    .split(/\s+/)
    .filter((w) => w.trim().length > 0)
    .filter(isProseWord);
  if (sentences.length === 0 || words.length === 0) return 0;

  const syllables = words.reduce((sum, word) => sum + countSyllables(word), 0);
  const grade =
    0.39 * (words.length / sentences.length) + 11.8 * (syllables / words.length) - 15.59;

  return Math.max(0, Math.round(grade * 10) / 10);
}
