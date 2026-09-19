/**
 * The code-side verifier between the model and the Network panel, modelled on `validateClaims`.
 *
 * The model proposes a graph; nothing it says about a number is taken on trust. Every node has to
 * quote text that really is in the block or table it names, the figure has to be inside that quote,
 * and the amount shown is parsed from the page's own characters here — the model's arithmetic is
 * never used. What survives is then checked against itself: children must add up to their parent
 * within the spec's 2%, and a parent that does not is flagged on the node rather than quietly
 * corrected or hidden.
 */

import type { FinEdge, FinNode, FinanceValidation, RawFinanceSignals } from "./finance-types";
import { detectCurrency, figureOccursIn, parseFigure, parseScaleNote } from "./finance-units";
import { MIN_QUOTE_CANDIDATE_WORDS, findVerifiedCore, normalizeWhitespace } from "./quote-match";

/** Spec's tolerance: a parent's children must sum to it within 2%. */
export const SUM_TOLERANCE = 0.02;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export interface PageSource {
  /** Whitespace-normalized, lowercased text of the block or table this id names. */
  haystack: string;
  /** Normalized cells and whole rows, for a `sourceText` that is a cell rather than a sentence. */
  spans: Set<string>;
  /** The multiplier this table's scale note states, e.g. 1e6 for "(in millions)". */
  scale: number | null;
  /** A currency named in the scale note ("$ in millions"), for cells that carry no symbol. */
  scaleCurrency: string | null;
}

export function buildPageSources(signals: RawFinanceSignals): Map<string, PageSource> {
  const sources = new Map<string, PageSource>();
  for (const block of signals.blocks) {
    if (!block.id) continue;
    sources.set(block.id, {
      haystack: normalizeWhitespace(block.text).toLowerCase(),
      spans: new Set(),
      scale: null,
      scaleCurrency: null,
    });
  }
  for (const table of signals.tables) {
    if (!table.id) continue;
    const spans = new Set<string>();
    for (const row of table.rows) {
      for (const cell of row) {
        const one = normalizeWhitespace(cell).toLowerCase();
        if (one) spans.add(one);
      }
      const whole = normalizeWhitespace(row.join(" ")).toLowerCase();
      if (whole) spans.add(whole);
    }
    const text = [table.caption, table.scaleNote, ...table.rows.map((row) => row.join(" "))].join(" ");
    sources.set(table.id, {
      haystack: normalizeWhitespace(text).toLowerCase(),
      spans,
      scale: parseScaleNote(table.scaleNote),
      scaleCurrency: detectCurrency(table.scaleNote, signals.currencyHints),
    });
  }
  return sources;
}

/**
 * Inspector's `findVerifiedCore` is the right contiguous-substring check, but it also accepts a
 * quote whose edges were trimmed to make it fit the page. Inspector stores that trimmed core and
 * highlights it; `FinNode` has nowhere to put one, so a padded quote here would be a node that
 * could never be highlighted. Only an exact result counts, and the rest are dropped.
 *
 * Its six-word floor is right for prose and wrong for a table: a cell reading "1,200" is a real
 * source and will never have six words in it. Cells and whole rows are matched against what the
 * collector actually read out of that table, so a short span still has to be a span of the page.
 */
export function verifySourceText(source: PageSource, sourceText: string): boolean {
  const normalized = normalizeWhitespace(sourceText).toLowerCase();
  if (!normalized) return false;
  if (source.spans.has(normalized)) return true;
  if (findVerifiedCore(source.haystack, normalized) !== normalized) return false;
  return normalized.split(" ").length >= MIN_QUOTE_CANDIDATE_WORDS;
}

/** The currency the page mostly writes in, resolved against every hint it showed. */
function pageCurrency(hints: readonly string[]): string {
  for (const hint of hints) {
    const found = detectCurrency(hint, hints);
    if (found) return found;
  }
  return "";
}

function reaches(adjacency: Map<string, string[]>, start: string, target: string): boolean {
  const queue = [start];
  const seen = new Set<string>();
  while (queue.length) {
    const at = queue.pop() as string;
    if (at === target) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    queue.push(...(adjacency.get(at) ?? []));
  }
  return false;
}

interface Limits {
  percentNodes: number;
  assumedCurrency: number;
  edgesToMissingNodes: number;
  edgesInCycles: number;
  checkedSums: number;
  uncheckedFigures: number;
  figures: number;
  mixedCurrency: string[];
  mixedPeriod: string[];
  currencies: Set<string>;
}

/**
 * The panel's honesty line. Every entry is a limit of this particular reading that still holds
 * after the checks ran: what was dropped and why, what could not be added up, what the page never
 * said. Nothing here is a general disclaimer about models or about money.
 */
function notCheckedLines(signals: RawFinanceSignals, limits: Limits): string[] {
  const lines: string[] = [];
  const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

  if (signals.truncated.length) {
    lines.push(`Only the first batch of ${signals.truncated.join(", ")} was read, so figures past that are not here.`);
  }
  if (limits.percentNodes > 0) {
    lines.push(
      `${count(limits.percentNodes, "percentage was", "percentages were")} left out. A percentage is not an amount, ` +
        `and adding one into a total would be wrong.`,
    );
  }
  if (limits.checkedSums > 0) {
    lines.push(
      "Whether a figure's listed parts are all of its parts. A breakdown that leaves a category out still adds up " +
        "short, and that looks the same here as a figure read wrong.",
    );
  }
  if (limits.uncheckedFigures > 0) {
    lines.push(
      `Arithmetic for ${count(limits.uncheckedFigures, "figure", "figures")} of the ${limits.figures} shown: the page ` +
        `states no parts for ${limits.uncheckedFigures === 1 ? "it" : "them"}, so there is nothing to add up.`,
    );
  }
  lines.push(...limits.mixedCurrency, ...limits.mixedPeriod);
  if (limits.edgesToMissingNodes > 0) {
    lines.push(
      `${count(limits.edgesToMissingNodes, "connection", "connections")} pointed at a figure that did not survive ` +
        `checking, so ${limits.edgesToMissingNodes === 1 ? "it is" : "they are"} not drawn.`,
    );
  }
  if (limits.edgesInCycles > 0) {
    lines.push(
      `${count(limits.edgesInCycles, "connection", "connections")} looped back into a figure they came from. A ` +
        `figure cannot be part of itself, so ${limits.edgesInCycles === 1 ? "it was" : "they were"} left out.`,
    );
  }
  if (limits.assumedCurrency > 0) {
    lines.push(
      `${count(limits.assumedCurrency, "figure is", "figures are")} printed with no currency on them. They are shown ` +
        `in ${pageCurrency(signals.currencyHints)} because that is what the rest of the page uses.`,
    );
  }
  if (limits.currencies.has("$")) {
    lines.push('The page writes "$" without saying which dollar it means. Nothing here decides between them.');
  }
  if (limits.currencies.has("¥")) {
    lines.push('The page writes "¥" without saying whether that is yen or yuan. Nothing here decides between them.');
  }
  if (limits.currencies.size > 1) {
    lines.push("Each figure is shown in the currency it was printed in. Nothing is converted and no rate is applied.");
  }
  return lines;
}

/**
 * Validates one model-proposed finance graph against the page it claims to have read.
 *
 * Throws when the response is not a graph at all, which the caller retries once with a repair
 * note. A malformed node or edge inside a well-formed response is dropped and counted, never
 * repaired.
 */
export function validateFinanceGraph(raw: unknown, signals: RawFinanceSignals): FinanceValidation {
  const root = obj(raw);
  if (!root || !Array.isArray(root.nodes)) throw new Error("Response was missing a nodes list.");
  const rawEdges = root.edges === undefined || root.edges === null ? [] : root.edges;
  if (!Array.isArray(rawEdges)) throw new Error("Response had an edges field that was not a list.");

  const sources = buildPageSources(signals);
  const hints = signals.currencyHints;
  const fallbackCurrency = pageCurrency(hints);
  const nodes: FinNode[] = [];
  const byId = new Map<string, FinNode>();
  let dropped = 0;
  let percentNodes = 0;
  let assumedCurrency = 0;

  for (const item of root.nodes) {
    const r = obj(item);
    const id = str(r?.id);
    const label = str(r?.label);
    const sourceId = str(r?.sourceId);
    const sourceText = str(r?.sourceText);
    const rawAmount = str(r?.rawAmount);
    if (!id || !label || !sourceId || !sourceText || !rawAmount || byId.has(id)) {
      dropped++;
      continue;
    }

    const source = sources.get(sourceId);
    if (!source || !verifySourceText(source, sourceText)) {
      dropped++;
      continue;
    }
    // A figure the page never printed in the sentence it was supposedly read from is a fabrication,
    // however real that sentence is.
    if (!figureOccursIn(sourceText, rawAmount)) {
      dropped++;
      continue;
    }

    const figure = parseFigure(rawAmount, { scale: source.scale, currencyHints: hints });
    if (!figure) {
      dropped++;
      continue;
    }
    if (figure.kind === "percent") {
      // `FinNode` has no way to say "this one is a proportion", and an amount field holding a
      // percentage is an amount waiting to be added into a total.
      percentNodes++;
      dropped++;
      continue;
    }

    let currency = figure.currency ?? source.scaleCurrency;
    if (!currency) {
      currency = fallbackCurrency;
      if (currency) assumedCurrency++;
    }

    const node: FinNode = { id, label, amount: figure.value, currency, sourceId, sourceText, rawAmount };
    const period = str(r?.period);
    if (period) node.period = period;
    nodes.push(node);
    byId.set(id, node);
  }

  const edges: FinEdge[] = [];
  const adjacency = new Map<string, string[]>();
  const seenEdges = new Set<string>();
  let edgesToMissingNodes = 0;
  let edgesInCycles = 0;

  for (const item of rawEdges) {
    const r = obj(item);
    const from = str(r?.from);
    const to = str(r?.to);
    const kind = r?.kind === "composition" || r?.kind === "flow" ? r.kind : undefined;
    if (!from || !to || !kind) continue;
    if (!byId.has(from) || !byId.has(to)) {
      edgesToMissingNodes++;
      continue;
    }
    // A self-edge and an edge that closes a loop are the same mistake: nothing can end up inside
    // where it started. The edge goes, not the nodes, so the figures themselves survive.
    if (from === to || reaches(adjacency, to, from)) {
      edgesInCycles++;
      continue;
    }
    const key = [from, to, kind].join("");
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ from, to, kind });
    adjacency.set(from, [...(adjacency.get(from) ?? []), to]);
  }

  const childrenOf = new Map<string, FinNode[]>();
  for (const edge of edges) {
    if (edge.kind !== "composition") continue;
    const child = byId.get(edge.to);
    if (child) childrenOf.set(edge.from, [...(childrenOf.get(edge.from) ?? []), child]);
  }

  const mixedCurrency: string[] = [];
  const mixedPeriod: string[] = [];
  const summed = new Set<string>();
  let mismatches = 0;
  let checkedSums = 0;

  for (const [parentId, children] of childrenOf) {
    const parent = byId.get(parentId);
    // One listed part says that the part exists, not that it is the whole of the parent.
    if (!parent || children.length < 2) continue;

    const currencies = new Set([parent.currency, ...children.map((child) => child.currency)]);
    if (currencies.size > 1) {
      mixedCurrency.push(
        `Whether "${parent.label}" adds up. Its parts are printed in ${[...currencies]
          .map((one) => one || "no stated currency")
          .join(" and ")}, and amounts in different currencies cannot be added.`,
      );
      continue;
    }
    const periods = new Set(children.flatMap((child) => (child.period ? [child.period] : [])));
    if (periods.size > 1) {
      mixedPeriod.push(
        `Whether "${parent.label}" adds up. Its parts cover ${[...periods].join(" and ")}, which are different ` +
          `periods and do not belong in one total.`,
      );
      continue;
    }

    checkedSums++;
    summed.add(parentId);
    for (const child of children) summed.add(child.id);

    const total = children.reduce((sum, child) => sum + child.amount, 0);
    const slack = Math.abs(parent.amount) * SUM_TOLERANCE;
    if (Math.abs(total - parent.amount) > slack + Math.abs(parent.amount) * 1e-9) {
      parent.warn = "children_sum_mismatch";
      mismatches++;
    }
  }

  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (node.currency) counts.set(node.currency, (counts.get(node.currency) ?? 0) + 1);
  }
  let currency = fallbackCurrency;
  let best = 0;
  for (const [one, seen] of counts) {
    if (seen > best) {
      best = seen;
      currency = one;
    }
  }

  const notChecked = notCheckedLines(signals, {
    percentNodes,
    assumedCurrency,
    edgesToMissingNodes,
    edgesInCycles,
    checkedSums,
    uncheckedFigures: nodes.length - summed.size,
    figures: nodes.length,
    mixedCurrency,
    mixedPeriod,
    currencies: new Set(counts.keys()),
  });

  return { graph: { nodes, edges, currency, notChecked }, dropped, mismatches };
}
