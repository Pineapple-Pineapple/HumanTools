export interface VerifiedExcerpt {
  excerpt: string;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Confirms that the source contains the inspected quote as one contiguous span.
 * Matching ignores presentation-only whitespace and case, but never accepts a paraphrase.
 */
export function verifySourceExcerpt(documentText: string, verifiedQuote: string): VerifiedExcerpt | null {
  const documentNormalized = normalize(documentText);
  const quoteNormalized = normalize(verifiedQuote);
  if (!documentNormalized || !quoteNormalized) return null;

  const index = documentNormalized.toLowerCase().indexOf(quoteNormalized.toLowerCase());
  if (index < 0) return null;

  const starts = [
    documentNormalized.lastIndexOf(". ", index),
    documentNormalized.lastIndexOf("! ", index),
    documentNormalized.lastIndexOf("? ", index),
  ]
    .filter((start) => start >= 0)
    .map((start) => start + 2);
  const sentenceStart = starts.length ? Math.max(...starts) : 0;
  const afterQuote = index + quoteNormalized.length;
  const endings = [
    documentNormalized.indexOf(". ", afterQuote),
    documentNormalized.indexOf("! ", afterQuote),
    documentNormalized.indexOf("? ", afterQuote),
  ].filter((ending) => ending >= 0);
  const sentenceEnd = endings.length ? Math.min(...endings) + 1 : documentNormalized.length;

  return { excerpt: documentNormalized.slice(sentenceStart, sentenceEnd) };
}
