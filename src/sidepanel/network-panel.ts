import { flashBySelector } from "../content/functions";
import { collectFinanceSignals } from "../content/finance-signals";
import { getActiveTabId } from "../lib/active-tab";
import { startFinanceGraph } from "../lib/messages";
import type { FinanceTrace, TraceState } from "../lib/messages";
import type { FinanceGraph, FinanceValidation, FinNode, RawFinanceSignals } from "../lib/finance-types";
import { createTabStore, getCurrentTabId, onTabActivated, onTabNavigated } from "../lib/tab-state";

const SECTION_LABEL = "text-[11px] uppercase tracking-wide text-neutral-500";
const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:hover:bg-amber-600 rounded text-neutral-950 font-medium";
const NOTE = "text-[11px] text-neutral-500 leading-snug";

const TRACE_ICON: Record<TraceState, string> = { running: "…", done: "✓", skipped: "–", failed: "✕" };
const TRACE_COLOR: Record<TraceState, string> = {
  running: "text-neutral-400",
  done: "text-emerald-400",
  skipped: "text-neutral-500",
  failed: "text-red-400",
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Turns scripting failures on pages extensions can't touch into something a reader understands. */
function pageAccessError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\//i.test(message)) {
    return "This page can't be modelled — browser pages and extension stores are off-limits to extensions.";
  }
  return message || "Couldn't read this page.";
}

/**
 * The figure as the page wrote it, not as we'd write it. Reformatting "1,200" from a table headed
 * "(in millions)" into "$1.2B" is a claim about what it means; showing both keeps the page's own
 * words next to our reading of them.
 */
function formatAmount(node: FinNode): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: node.currency,
      notation: Math.abs(node.amount) >= 1_000_000 ? "compact" : "standard",
      maximumFractionDigits: 2,
    }).format(node.amount);
  } catch {
    return `${node.amount}`;
  }
}

interface TreeRow {
  node: FinNode;
  depth: number;
}

/**
 * Orders the graph for an indented tree. A Sankey is the spec's other option, but a side panel is a
 * ~400px column and the page body cannot scroll sideways, so the tree is what actually fits.
 * Nodes nobody composes are roots; anything unreachable is still shown, at the end, rather than
 * dropped — a figure the validator kept should never vanish because the model's edges were odd.
 */
function layoutTree(graph: FinanceGraph): TreeRow[] {
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const edge of graph.edges) {
    if (!graph.nodes.some((n) => n.id === edge.from) || !graph.nodes.some((n) => n.id === edge.to)) continue;
    children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
    hasParent.add(edge.to);
  }

  const rows: TreeRow[] = [];
  const seen = new Set<string>();

  function walk(id: string, depth: number): void {
    if (seen.has(id)) return; // a cycle, or a node composed by two parents
    seen.add(id);
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return;
    rows.push({ node, depth });
    for (const child of children.get(id) ?? []) walk(child, depth + 1);
  }

  for (const node of graph.nodes) if (!hasParent.has(node.id)) walk(node.id, 0);
  for (const node of graph.nodes) if (!seen.has(node.id)) rows.push({ node, depth: 0 });
  return rows;
}

interface NetworkView {
  validation: FinanceValidation;
  signals: RawFinanceSignals;
  status: string;
}

export function mountNetworkPanel(container: HTMLElement): void {
  const root = el("div", "p-4 flex flex-col gap-4 text-sm");
  container.appendChild(root);

  const header = el("div", "flex flex-col gap-1.5");
  header.append(el("h1", "text-neutral-100 font-medium", "Network — where is the money going?"));
  header.append(
    el(
      "p",
      "text-xs text-neutral-400 leading-relaxed",
      "Turns this page's own figures into a structure you can follow. Every amount shown is one the " +
        "page states — anything that can't be found in the text is dropped rather than displayed, and " +
        "subtotals that don't add up are flagged instead of corrected.",
    ),
  );
  root.appendChild(header);

  const modelBtn = el("button", `self-start ${BTN_PRIMARY}`, "Model this page");
  root.appendChild(modelBtn);

  const status = el("p", "text-xs text-neutral-500 min-h-[1em]", "Nothing modelled yet.");
  root.appendChild(status);

  const graphSection = el("div", "flex flex-col gap-1");
  root.appendChild(graphSection);

  const traceDetails = el("details", "text-xs");
  traceDetails.hidden = true;
  const traceSummary = el("summary", "cursor-pointer text-neutral-400 hover:text-neutral-200", "Trace");
  const traceList = el("div", "flex flex-col gap-1 pt-2");
  traceDetails.append(traceSummary, traceList);
  root.appendChild(traceDetails);

  const footer = el("div", "flex flex-col gap-1.5 pt-3 border-t border-neutral-800");
  footer.hidden = true;
  root.appendChild(footer);

  const views = createTabStore<NetworkView>();
  const traceRows = new Map<string, HTMLElement>();
  let runId = 0;

  function isCurrentTab(tabId: number): boolean {
    const current = getCurrentTabId();
    return current === null || current === tabId;
  }

  function addTrace(step: string, state: TraceState, detail?: string, ms?: number): void {
    traceDetails.hidden = false;
    const row = traceRows.get(step) ?? el("div", "flex gap-2");
    traceRows.set(step, row);
    if (!row.parentElement) traceList.appendChild(row);
    const parts = [detail, ms !== undefined ? `${Math.round(ms)} ms` : undefined].filter(Boolean).join(" · ");
    row.replaceChildren(
      el("span", `${TRACE_COLOR[state]} w-3 shrink-0`, TRACE_ICON[state]),
      el("span", "text-neutral-300 shrink-0", step),
      el("span", "text-neutral-500 min-w-0 break-words", parts),
    );
  }

  /** Scrolls the figure's own block or table cell into view and flashes it. */
  async function showSource(tabId: number, sourceId: string): Promise<void> {
    await chrome.scripting
      .executeScript({
        target: { tabId },
        func: flashBySelector,
        args: [`[data-ht-fin-id="${CSS.escape(sourceId)}"]`],
      })
      .catch(() => {});
  }

  function renderNode(node: FinNode, depth: number, tabId: number): HTMLElement {
    const row = el("div", "flex flex-col gap-0.5 rounded border border-neutral-700 bg-neutral-800/70 p-2");
    row.style.marginLeft = `${depth * 12}px`;

    const top = el("div", "flex items-baseline justify-between gap-2");
    top.append(
      el("span", "text-neutral-100 min-w-0 break-words", node.label),
      el("span", "shrink-0 font-mono text-neutral-100", formatAmount(node)),
    );
    row.appendChild(top);

    const meta = [node.period, `as written: ${node.rawAmount}`].filter(Boolean).join(" · ");
    row.appendChild(el("div", "text-[11px] text-neutral-500", meta));

    if (node.warn === "children_sum_mismatch") {
      row.appendChild(
        el(
          "div",
          "text-[11px] text-amber-300",
          "⚑ The figures under this one don't add up to it. Both are shown as the page states them.",
        ),
      );
    }

    const source = el("button", "text-left text-[11px] text-neutral-400 hover:text-amber-300 italic break-words");
    source.textContent = `“${node.sourceText.length > 140 ? `${node.sourceText.slice(0, 140)}…` : node.sourceText}”`;
    source.title = "Show it on the page";
    source.addEventListener("click", () => void showSource(tabId, node.sourceId));
    row.appendChild(source);

    return row;
  }

  function render(view: NetworkView, tabId: number): void {
    const { graph, dropped, mismatches } = view.validation;
    graphSection.replaceChildren();

    if (!graph.nodes.length) {
      graphSection.appendChild(
        el(
          "p",
          "text-xs text-neutral-400",
          "No amounts on this page could be traced to the text they came from, so nothing is shown. " +
            "That is not a statement about the page's figures — only that none of them survived the check.",
        ),
      );
    } else {
      graphSection.appendChild(
        el("div", SECTION_LABEL, `Amounts · ${graph.nodes.length}${mismatches ? ` · ${mismatches} flagged` : ""}`),
      );
      for (const { node, depth } of layoutTree(graph)) graphSection.appendChild(renderNode(node, depth, tabId));
    }

    footer.replaceChildren(el("div", SECTION_LABEL, "What we could not check"));
    // The collector records what it skipped or capped; dropping that on the floor would let the
    // panel present a slice of the page as though it were the whole of it.
    const lines = [...view.signals.truncated, ...graph.notChecked];
    if (dropped > 0) {
      lines.push(
        `${dropped} amount${dropped === 1 ? "" : "s"} the model proposed could not be found in the page's own ` +
          `text and ${dropped === 1 ? "was" : "were"} dropped.`,
      );
    }
    for (const line of lines) footer.appendChild(el("p", NOTE, line));
    footer.appendChild(
      el("p", NOTE, "Figures are read from this page only. Nothing here is compared against a filing or any other source."),
    );
    footer.hidden = false;

    status.textContent = view.status;
  }

  function clear(): void {
    graphSection.replaceChildren();
    traceList.replaceChildren();
    traceRows.clear();
    traceDetails.hidden = true;
    footer.hidden = true;
  }

  async function model(tabId: number): Promise<void> {
    const myRun = ++runId;
    clear();
    modelBtn.disabled = true;
    status.textContent = "Reading the page…";

    let signals: RawFinanceSignals;
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: collectFinanceSignals });
      const result = injection?.result;
      if (!result || (!result.blocks.length && !result.tables.length)) {
        status.textContent = "No figures found on this page to model.";
        modelBtn.disabled = false;
        return;
      }
      signals = result;
    } catch (err) {
      if (myRun === runId) {
        status.textContent = pageAccessError(err);
        modelBtn.disabled = false;
      }
      return;
    }
    if (myRun !== runId || !isCurrentTab(tabId)) return;

    status.textContent = "Modelling…";
    startFinanceGraph(signals, {
      onTrace: (msg: FinanceTrace) => {
        if (myRun === runId) addTrace(msg.step, msg.state, msg.detail, msg.ms);
      },
      onResult: (msg) => {
        if (myRun !== runId) return;
        modelBtn.disabled = false;
        if (msg.error || !msg.validation) {
          status.textContent = msg.error ?? "Could not model this page.";
          return;
        }
        const kept = msg.validation.graph.nodes.length;
        const view: NetworkView = {
          validation: msg.validation,
          signals,
          status: `${kept} amount${kept === 1 ? "" : "s"} traced to the page. Click one to find it.`,
        };
        views.set(tabId, view);
        if (isCurrentTab(tabId)) render(view, tabId);
      },
    });
  }

  modelBtn.addEventListener("click", async () => {
    const tabId = getCurrentTabId() ?? (await getActiveTabId());
    void model(tabId);
  });

  // Modelling a page costs an API call, so switching tabs only ever swaps what is displayed.
  // Nothing here re-runs on its own; the reader asks for each page explicitly.
  onTabActivated((tabId) => {
    runId++; // anything in flight belongs to the tab the reader just left
    modelBtn.disabled = false;
    clear();
    const view = views.get(tabId);
    if (!view) {
      status.textContent = "Nothing modelled yet.";
      return;
    }
    render(view, tabId);
  });

  // tab-state has already dropped this tab's graph — its figures described a page that is gone.
  // Clear the screen rather than re-modelling: that would spend the reader's key without asking.
  onTabNavigated(() => {
    runId++;
    modelBtn.disabled = false;
    clear();
    status.textContent = "This page changed. Model it again to see its figures.";
  });
}
