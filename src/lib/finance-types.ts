/**
 * The contract between the Network panel's three layers: what the page collector measures, what
 * the model is asked to produce, and what survives validation.
 *
 * The rule the whole panel rests on: a figure reaches the screen only if the text it came from is
 * literally on the page. The model proposes; `finance-validate` decides. Nothing here is a verdict
 * about a company — it is a restatement of arithmetic the page already printed.
 */

/** A prose block that mentions money. `id` is the `data-ht-fin-id` stamped on the element. */
export interface FinanceBlock {
  id: string;
  text: string;
}

export interface FinanceTable {
  id: string;
  /** Caption or nearest preceding heading, for the model's benefit. */
  caption: string;
  /**
   * A scale stated in the caption or header, verbatim — "(in millions)", "$ in thousands".
   * Table cells are routinely printed in a unit the cell itself never names.
   */
  scaleNote: string;
  rows: string[][];
}

/** What the collector reads off the page. Measurement only, no judgement. */
export interface RawFinanceSignals {
  url: string;
  title: string;
  blocks: FinanceBlock[];
  tables: FinanceTable[];
  /** Currency symbols or codes seen on the page, most frequent first. */
  currencyHints: string[];
  /** Set when a cap was hit, so the panel can say so rather than quietly analysing a slice. */
  truncated: string[];
}

export interface FinNode {
  id: string;
  label: string;
  /** Normalized to the base unit of `currency` — dollars, not millions of dollars. */
  amount: number;
  currency: string;
  /** e.g. "FY2025", "Q3 2026". Absent when the page doesn't say. */
  period?: string;
  /** The `data-ht-fin-id` of the block or table the figure was read from. */
  sourceId: string;
  /**
   * The verbatim sentence or table cell containing the figure. Long enough to be unique on the
   * page, which a bare "$4.2 billion" is not — that is what makes click-to-highlight land on the
   * right occurrence.
   */
  sourceText: string;
  /** The figure as the page wrote it: "$1.2 billion", "1,200", "(3,410)". */
  rawAmount: string;
  /** Set by the validator when this node's children don't sum to it within tolerance. */
  warn?: "children_sum_mismatch";
}

export interface FinEdge {
  from: string;
  to: string;
  kind: "composition" | "flow";
}

export interface FinanceGraph {
  nodes: FinNode[];
  edges: FinEdge[];
  currency: string;
  /** Real limits of this reading, shown to the reader. Never a list of excuses. */
  notChecked: string[];
}

export interface FinanceValidation {
  graph: FinanceGraph;
  /** Nodes discarded because their `sourceText` was not on the page. */
  dropped: number;
  /** Parents whose children did not sum within tolerance — flagged on the node, never hidden. */
  mismatches: number;
}
