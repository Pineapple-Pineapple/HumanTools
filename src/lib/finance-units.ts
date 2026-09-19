/**
 * Reading the money a page prints.
 *
 * Every function here returns null rather than a plausible number. A wrong figure is the worst
 * thing the Network panel can produce, and a refusal can be counted and shown; a guess that
 * happened to be wrong cannot. The two places a page is genuinely ambiguous — which dollar "$"
 * means, and whether "1.200" is one thousand two hundred or one point two — are refusals here,
 * not defaults.
 */

const ODD_SPACES = /[     - ]/g;

/** Non-breaking spaces and the unicode minus folded to their plain equivalents. */
export function normalizeFigureText(text: string): string {
  return text.replace(ODD_SPACES, " ").replace(/−/g, "-").replace(/\s+/g, " ").trim();
}

/** True when `figure` is written inside `text` character for character, ignoring only spacing. */
export function figureOccursIn(text: string, figure: string): boolean {
  const needle = normalizeFigureText(figure).toLowerCase();
  return needle.length > 0 && normalizeFigureText(text).toLowerCase().includes(needle);
}

const MAGNITUDES: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  thousands: 1e3,
  m: 1e6,
  mm: 1e6,
  mn: 1e6,
  million: 1e6,
  millions: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  billions: 1e9,
  t: 1e12,
  tn: 1e12,
  trillion: 1e12,
  trillions: 1e12,
};

/** The multiplier a magnitude word names: "bn" and "billion" are both 1e9. Null for anything else. */
export function parseMagnitude(word: string): number | null {
  const key = normalizeFigureText(word).toLowerCase().replace(/\.$/, "");
  return MAGNITUDES[key] ?? null;
}

/**
 * A grouped numeral with no sign, currency or magnitude on it: "1,200", "1 200", "1.200,50".
 *
 * Separator rules, in the order they are tried:
 * - Both "," and "." present: the last one to appear is the decimal separator, the other groups.
 * - One kind, appearing more than once: it groups ("1.234.567").
 * - One ",", with other than three digits after it: it is a decimal ("1,5" is 1.5).
 * - One ",", with exactly three digits after it: it groups. "1,200" is 1200. A comma decimal
 *   carrying exactly three decimal places is vanishingly rare in the financial writing this panel
 *   reads, and comma grouping is everywhere in it.
 * - One ".", with exactly three digits after it: refused. "1.200" is one thousand two hundred to
 *   half the world and one-point-two to the other half, and nothing in the string says which. The
 *   one exception is a leading zero ("0.500"), which cannot be a grouped integer.
 * - Spaces and apostrophes always group.
 *
 * Groups are then checked: every group after the first must be exactly three digits. That rejects
 * malformed grouping ("1,20,000") rather than quietly reading it as something.
 */
export function parseNumeral(text: string): number | null {
  const s = normalizeFigureText(text);
  if (!/^\d(?:[\d.,' ]*\d)?$/.test(s)) return null;

  const commas = s.split(",").length - 1;
  const dots = s.split(".").length - 1;
  let decimal: string | null = null;

  if (commas > 0 && dots > 0) {
    decimal = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    if ((decimal === "," ? commas : dots) > 1) return null;
  } else if (commas === 1 || dots === 1) {
    const sep = commas === 1 ? "," : ".";
    const trailing = s.length - s.lastIndexOf(sep) - 1;
    if (trailing !== 3) decimal = sep;
    else if (sep === ",") decimal = null;
    else if (s.startsWith("0")) decimal = ".";
    else return null;
  }

  const cut = decimal ? s.lastIndexOf(decimal) : -1;
  const whole = cut < 0 ? s : s.slice(0, cut);
  const fraction = cut < 0 ? "" : s.slice(cut + 1);
  if (decimal && !/^\d+$/.test(fraction)) return null;

  const groups = whole.split(/[.,' ]/);
  if (groups.some((group) => !/^\d+$/.test(group))) return null;
  if (groups.length > 1) {
    if (groups[0].length > 3) return null;
    if (groups.slice(1).some((group) => group.length !== 3)) return null;
  }

  const value = Number(groups.join("") + (fraction ? `.${fraction}` : ""));
  return Number.isFinite(value) ? value : null;
}

/**
 * The multiplier a table's scale note states: "(in millions)" is 1e6. Table cells are routinely
 * printed in a unit the cell itself never names, and this is the only thing that knows it.
 * Returns null when the note names no scale, and also when it names two — a note that says both
 * thousands and millions is not something to pick a winner from.
 */
export function parseScaleNote(note: string): number | null {
  const s = normalizeFigureText(note).toLowerCase();
  if (!s) return null;

  const found = new Set<number>();
  for (const match of s.matchAll(/\b(thousands?|millions?|billions?|trillions?)\b/g)) {
    found.add(MAGNITUDES[match[1]]);
  }
  // "$ in 000s", "in '000" — the digits must not be the tail of a grouped number like "$1,000".
  if (/(^|[^0-9.,])'?000s?\b/.test(s)) found.add(1e3);

  return found.size === 1 ? [...found][0] : null;
}

/**
 * Dollar signs are not a currency. "$" is written by the US, Canada, Australia, Hong Kong and
 * others, so a bare "$" stays "$" unless the page says which dollar it means — in the figure
 * itself ("US$1.2bn", "1.2bn CAD") or in the currency hints the collector read off the rest of
 * the page. "¥" is ambiguous between the yen and the yuan the same way. Symbols only one currency
 * uses resolve straight to its code.
 *
 * Order matters: the longer, more specific pattern has to be tried before the symbol inside it.
 */
const CURRENCY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bu\.?s\.?\s?\$/, "USD"],
  [/\b(?:us|u\.s\.)\s?dollars?\b/, "USD"],
  [/\bcanadian\s?dollars?\b/, "CAD"],
  [/\b(?:c|ca)\$/, "CAD"],
  [/\baustralian\s?dollars?\b/, "AUD"],
  [/\b(?:a|au)\$/, "AUD"],
  [/\bnz\$/, "NZD"],
  [/\bhk\$/, "HKD"],
  [/\bs\$/, "SGD"],
  [/\br\$/, "BRL"],
  [/\b(?:usd|cad|aud|nzd|gbp|eur|jpy|cny|chf|inr|mxn|hkd|sgd|sek|nok|dkk|brl|zar|krw)\b/, ""],
  [/\brmb\b/, "CNY"],
  [/€/, "EUR"],
  [/£/, "GBP"],
  [/₹/, "INR"],
  [/₩/, "KRW"],
  [/¥/, "¥"],
  [/\$/, "$"],
  [/\beuros?\b/, "EUR"],
  [/\b(?:pounds?\s?sterling|pounds?|sterling)\b/, "GBP"],
  [/\brupees?\b/, "INR"],
  [/\byen\b/, "¥"],
  [/\byuan\b/, "CNY"],
  [/\bdollars?\b/, "$"],
];

const FAMILIES: Record<string, readonly string[]> = {
  $: ["USD", "CAD", "AUD", "NZD", "HKD", "SGD", "BRL", "MXN"],
  "¥": ["JPY", "CNY"],
};

function findCurrency(lowered: string): { token: string; text: string } | null {
  for (const [pattern, fixed] of CURRENCY_PATTERNS) {
    const match = lowered.match(pattern);
    if (match) return { token: fixed || match[0].toUpperCase(), text: match[0] };
  }
  return null;
}

/**
 * Resolves an ambiguous symbol against what the rest of the page showed: "$" on a page that also
 * writes "CAD" and nothing else dollar-shaped is Canadian. A page showing both USD and CAD leaves
 * it as "$", because there is no honest way to pick.
 */
export function resolveCurrency(token: string, hints: readonly string[] = []): string {
  const family = FAMILIES[token];
  if (!family) return token;
  const named = new Set<string>();
  for (const hint of hints) {
    const found = findCurrency(normalizeFigureText(hint).toLowerCase());
    if (found && family.includes(found.token)) named.add(found.token);
  }
  return named.size === 1 ? [...named][0] : token;
}

/** The currency a piece of text names: an ISO code, or the bare symbol when it stays ambiguous. */
export function detectCurrency(text: string, hints: readonly string[] = []): string | null {
  const found = findCurrency(normalizeFigureText(text).toLowerCase());
  return found ? resolveCurrency(found.token, hints) : null;
}

export interface FigureContext {
  /** The multiplier from the enclosing table's scale note, if it has one. */
  scale?: number | null;
  /** Currency symbols and codes seen elsewhere on the page, most frequent first. */
  currencyHints?: readonly string[];
}

export interface ParsedAmount {
  kind: "amount";
  /** Base units of `currency`: dollars, not millions of dollars. */
  value: number;
  /** An ISO code, "$" or "¥" when the page never says which, or null when no currency is named. */
  currency: string | null;
  /** The multiplier the figure named itself: 1e9 for "$1.2 billion". Null when the figure is bare. */
  namedScale: number | null;
  /** True when the table's scale note supplied the multiplier instead. Never both. */
  scaleApplied: boolean;
}

export interface ParsedPercent {
  kind: "percent";
  /** The percentage as written: 12.5 for "12.5%". Never a summable quantity. */
  value: number;
}

export type ParsedFigure = ParsedAmount | ParsedPercent;

/**
 * Parses one figure exactly as the page wrote it — "$1.2 billion", "(3,410)", "1,200", "12.5%" —
 * into a number in the currency's base unit.
 *
 * A figure that names its own magnitude is never scaled again by its table: "$1.2 billion" inside
 * an "in millions" table is 1.2e9, not 1.2e15. The cell's own unit wins.
 *
 * The string has to be the figure and nothing else. "about $5 million" and "$12m of $30m" are
 * refused: anything left over after the sign, currency, numeral and magnitude have been accounted
 * for means this is not a single figure, and parsing on anyway is how a total ends up wrong.
 */
export function parseFigure(raw: string, context: FigureContext = {}): ParsedFigure | null {
  let s = normalizeFigureText(raw).toLowerCase();
  if (!s) return null;

  const currency = findCurrency(s);
  if (currency) {
    const at = s.indexOf(currency.text);
    s = normalizeFigureText(s.slice(0, at) + s.slice(at + currency.text.length));
  }

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  }

  const percentSuffix = s.match(/\s*(?:%|percent(?:age)?|pct)$/);
  if (percentSuffix) s = s.slice(0, s.length - percentSuffix[0].length).trim();

  const parts = s.match(/^([0-9][0-9.,' ]*[0-9]|[0-9])(?:\s*([a-z]{1,8}\.?))?$/);
  if (!parts) return null;

  const numeral = parseNumeral(parts[1]);
  if (numeral === null) return null;

  const magnitude = parts[2] === undefined ? null : parseMagnitude(parts[2]);
  if (parts[2] !== undefined && magnitude === null) return null;

  if (percentSuffix) {
    // A percentage with a currency or a magnitude on it is not a percentage of anything this can
    // work out, and it is certainly not an amount.
    if (currency || magnitude !== null) return null;
    return { kind: "percent", value: negative ? -numeral : numeral };
  }

  const scale = context.scale ?? null;
  const multiplier = magnitude ?? scale ?? 1;
  const value = numeral * multiplier;
  return {
    kind: "amount",
    value: negative ? -value : value,
    currency: currency ? resolveCurrency(currency.token, context.currencyHints ?? []) : null,
    namedScale: magnitude,
    scaleApplied: magnitude === null && scale !== null,
  };
}
