import {
  applyOutlineLabels,
  captureInspectTarget,
  clearClaimMarks,
  extractOutline,
  flashBySelector,
  markClaims,
  startPickMode,
  stopPickMode,
  watchSelection,
} from "../content/functions";
import { requestOutlineLabels, startInspect } from "../lib/messages";
import type { InspectTrace, TraceState } from "../lib/messages";
import { getActiveTabId, onActiveTabChange } from "../lib/active-tab";
import { getSourceTracerUrl } from "../lib/provider";
import { heuristicClaimType, splitSentences } from "../lib/claim-heuristics";
import type { ContextSource, SourceContextReason, SourceQuality, VerifiedSource } from "../lib/source-tracer-client";
import type {
  ClaimCard,
  ClaimType,
  EvidenceStatus,
  FramingFlagKind,
  InspectTarget,
  OutlineBlock,
  OutlineLabel,
  SlopReport,
} from "../lib/types";

const TYPE_LABELS: Record<ClaimType, string> = {
  fact: "Fact",
  opinion: "Opinion",
  speculation: "Speculation",
  prediction: "Prediction",
  quote: "Quote",
};

const STATUS_LABELS: Record<EvidenceStatus, string> = {
  supported: "Supported",
  partly_supported: "Partly supported",
  unverified: "Unverified",
  contradicted: "Contradicted",
};

const STATUS_CHIP: Record<EvidenceStatus, string> = {
  supported: "bg-emerald-950 text-emerald-300 border-emerald-800",
  partly_supported: "bg-amber-950 text-amber-300 border-amber-800",
  unverified: "bg-neutral-800 text-neutral-300 border-neutral-600",
  contradicted: "bg-red-950 text-red-300 border-red-800",
};

const STATUS_BADGE: Record<EvidenceStatus, string> = {
  supported: "border-emerald-400 text-emerald-300",
  partly_supported: "border-amber-400 text-amber-300",
  unverified: "border-neutral-400 text-neutral-300",
  contradicted: "border-red-400 text-red-300",
};

const FLAG_LABELS: Record<FramingFlagKind, string> = {
  base_effect: "Base effect",
  cherry_picked_window: "Cherry-picked window",
  missing_denominator: "Missing denominator",
  relative_vs_absolute: "Relative vs. absolute",
  loaded_wording: "Loaded wording",
};

const OUTLINE_ORDER: OutlineLabel[] = ["important", "supporting", "boilerplate", "navigation", "advertisement"];

const OUTLINE_LABEL_TEXT: Record<OutlineLabel, string> = {
  important: "Important",
  supporting: "Supporting",
  boilerplate: "Boilerplate",
  navigation: "Navigation",
  advertisement: "Ad",
};

const OUTLINE_CHIP: Record<OutlineLabel, string> = {
  important: "bg-amber-950 text-amber-300 border-amber-800",
  supporting: "bg-neutral-800 text-neutral-300 border-neutral-600",
  boilerplate: "bg-neutral-900 text-neutral-500 border-neutral-700",
  navigation: "bg-sky-950 text-sky-300 border-sky-800",
  advertisement: "bg-red-950 text-red-300 border-red-800",
};

const TRACE_ICON: Record<TraceState, string> = { running: "…", done: "✓", skipped: "–", failed: "✕" };
const TRACE_ICON_CLASS: Record<TraceState, string> = {
  running: "text-amber-400",
  done: "text-emerald-400",
  skipped: "text-neutral-500",
  failed: "text-red-400",
};

const BTN =
  "inline-flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-neutral-800 border border-neutral-600 rounded text-neutral-100";
const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:hover:bg-amber-600 rounded text-neutral-950 font-medium";
const CHIP = "inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] leading-none";
const NO_SELECTION_HINT = "Select a sentence or paragraph on the page first (at least a few words).";
const SECTION_LABEL = "text-[11px] uppercase tracking-wide text-neutral-500";

export function sourceContextMessage(reasons: readonly SourceContextReason[]): string {
  if (reasons.includes("page_context") && reasons.includes("non_factual_context")) {
    return "This is the inspected page and a known satire/non-factual publisher — not evidence for this claim.";
  }
  if (reasons.includes("page_context")) return "This exact text appears on the inspected page — not external verification.";
  return "Known satire/non-factual publisher — not evidence for this claim.";
}

export function sourceQualityMessage(quality: SourceQuality): string {
  return quality === "institutional_signal" ? "Institutional/public-record signal" : "Credibility not established";
}

/**
 * The line shown under "External verification" when no sources are listed. A tracer that never ran
 * must never read as a tracer that ran and found nothing — that would be a finding about the claim.
 */
export function noExternalSourcesMessage(notChecked?: string): string {
  return notChecked ? `Not checked — ${notChecked}` : "No external verification found.";
}

const INSPECTION_KEY = "inspection";

/** A finished inspection, kept in session storage so it outlives the side panel being closed. */
interface SavedInspection {
  tabId: number;
  target: InspectTarget;
  claims: ClaimCard[];
  slop?: { report?: SlopReport; note?: string };
  sources?: {
    sourcesByQuote: Record<string, VerifiedSource[]>;
    contextsByQuote: Record<string, ContextSource[]>;
    notCheckedByQuote: Record<string, string>;
  };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function crosshairIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ["M8 1v3", "M8 12v3", "M1 8h3", "M12 8h3"]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  const circle = document.createElementNS(ns, "circle");
  circle.setAttribute("cx", "8");
  circle.setAttribute("cy", "8");
  circle.setAttribute("r", "4");
  svg.appendChild(circle);
  return svg;
}

/** Turns scripting failures on pages extensions can't touch into something a reader understands. */
function pageAccessError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\//i.test(message)) {
    return "This page can't be inspected — browser pages and extension stores are off-limits to extensions.";
  }
  return message || "Couldn't read this page.";
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export interface InspectorOptions {
  /** Switches the side panel to the Inspector tab (e.g. when a claim badge on the page is clicked). */
  activate: () => void;
}

export function mountInspectorPanel(container: HTMLElement, options: InspectorOptions): void {
  const root = el("div", "p-4 flex flex-col gap-4 text-sm");
  container.appendChild(root);

  // ---- Header and mode switch -----------------------------------------------------------------
  const header = el("div", "flex flex-col gap-2");
  header.appendChild(el("h1", "text-neutral-100 font-medium", "Inspector — what am I looking at?"));
  const modeRow = el("div", "inline-flex self-start rounded border border-neutral-700 overflow-hidden text-xs");
  const claimsTab = el("button", "", "Claims");
  const outlineTab = el("button", "", "Outline");
  modeRow.append(claimsTab, outlineTab);
  header.appendChild(modeRow);
  root.appendChild(header);

  const claimsView = el("div", "flex flex-col gap-4");
  const outlineView = el("div", "flex flex-col gap-4");
  root.append(claimsView, outlineView);

  function setMode(mode: "claims" | "outline"): void {
    const on = "px-3 py-1.5 bg-neutral-700 text-neutral-100";
    const off = "px-3 py-1.5 text-neutral-400 hover:text-neutral-200";
    claimsTab.className = mode === "claims" ? on : off;
    outlineTab.className = mode === "outline" ? on : off;
    claimsView.hidden = mode !== "claims";
    outlineView.hidden = mode !== "outline";
  }
  claimsTab.addEventListener("click", () => setMode("claims"));
  outlineTab.addEventListener("click", () => setMode("outline"));
  setMode("claims");

  // ---- Claims view ----------------------------------------------------------------------------
  const toolbar = el("div", "flex flex-wrap gap-2");
  const pickBtn = el("button", BTN);
  const pickLabel = el("span", "", "Pick paragraph");
  pickBtn.append(crosshairIcon(), pickLabel);
  const inspectBtn = el("button", BTN_PRIMARY, "Inspect selection");
  inspectBtn.disabled = true;
  inspectBtn.title = NO_SELECTION_HINT;
  const clearBtn = el("button", BTN, "Clear");
  clearBtn.hidden = true;
  toolbar.append(pickBtn, inspectBtn, clearBtn);

  const status = el(
    "p",
    "text-xs text-neutral-500 min-h-[1em]",
    "Pick a paragraph on the page, or select some text and press Inspect selection.",
  );

  const passageSection = el("div", "flex flex-col gap-1.5");
  const provisionalSection = el("div", "flex flex-col gap-1.5");
  const slopSection = el("div", "flex flex-col gap-1.5");
  const claimsSection = el("div", "flex flex-col gap-3");
  const traceDetails = el("details", "text-xs text-neutral-400");
  const traceSummary = el("summary", "cursor-pointer select-none text-neutral-500 hover:text-neutral-300", "Trace");
  const traceList = el("div", "flex flex-col gap-1 mt-2");
  traceDetails.append(traceSummary, traceList);
  const claimsFooter = el(
    "p",
    "text-[11px] text-neutral-500 border-t border-neutral-800 pt-3",
    "A matching source is evidence only when it is a distinct eligible external page. Text found on this page is context, not verification. " +
      "No result is not proof that a claim is false.",
  );
  for (const section of [passageSection, provisionalSection, slopSection, claimsSection, traceDetails, claimsFooter]) {
    section.hidden = true;
  }
  claimsView.append(toolbar, status, passageSection, provisionalSection, claimsSection, slopSection, traceDetails, claimsFooter);

  let runId = 0;
  let cancelInspect: (() => void) | null = null;
  let inspectedTabId: number | null = null;
  let inspectedTarget: InspectTarget | null = null;
  /** Whether a Source Tracer endpoint is set, so cards don't claim to be checking when nothing will. */
  let tracerConfigured = false;
  /**
   * The finished inspection, mirrored to session storage. Closing the side panel destroys the
   * panel's JS context, and with it the card map the page's claim badges message back into — so
   * without this, every badge on the page goes dead the moment the panel is reopened.
   */
  let saved: SavedInspection | null = null;

  function persistInspection(): void {
    if (saved) void chrome.storage.session.set({ [INSPECTION_KEY]: saved });
  }

  function forgetInspection(): void {
    saved = null;
    void chrome.storage.session.remove(INSPECTION_KEY);
  }
  let pickTabId: number | null = null;
  const cards = new Map<number, HTMLElement>();
  const sourceSections = new Map<string, { context: HTMLElement; external: HTMLElement }>();
  const traceRows = new Map<string, HTMLElement>();

  function setStatus(text: string): void {
    status.textContent = text;
  }

  /** The tab whose HT_SELECTION reports drive the Inspect selection button. */
  let selectionTabId: number | null = null;

  function setCanInspect(canInspect: boolean): void {
    inspectBtn.disabled = !canInspect;
    inspectBtn.title = canInspect ? "" : NO_SELECTION_HINT;
  }

  /** Starts listening to the active tab's selection; it reports straight back via HT_SELECTION. */
  async function watchActiveSelection(): Promise<void> {
    setCanInspect(false);
    selectionTabId = null;
    try {
      const tabId = await getActiveTabId();
      selectionTabId = tabId;
      await chrome.scripting.executeScript({ target: { tabId }, func: watchSelection });
    } catch {
      // Pages the extension can't script (chrome://, the Web Store) never have an inspectable selection.
    }
  }

  function setPicking(tabId: number | null): void {
    pickTabId = tabId;
    pickLabel.textContent = tabId === null ? "Pick paragraph" : "Cancel picking";
  }

  function addTrace(step: string, state: TraceState, detail?: string, ms?: number): void {
    traceDetails.hidden = false;
    let row = traceRows.get(step);
    if (!row) {
      row = el("div", "flex gap-2 items-baseline");
      traceRows.set(step, row);
      traceList.appendChild(row);
    }
    const icon = el("span", `w-3 shrink-0 text-center ${TRACE_ICON_CLASS[state]}`, TRACE_ICON[state]);
    const name = el("span", "text-neutral-300 shrink-0", step);
    const parts = [detail, ms !== undefined ? formatMs(ms) : undefined].filter(Boolean).join(" · ");
    const info = el("span", "text-neutral-500 min-w-0 break-words", parts);
    row.replaceChildren(icon, name, info);
  }

  function resetResults(): void {
    cards.clear();
    sourceSections.clear();
    traceRows.clear();
    traceList.replaceChildren();
    for (const section of [passageSection, provisionalSection, slopSection, claimsSection]) section.replaceChildren();
    for (const section of [passageSection, provisionalSection, slopSection, claimsSection, traceDetails, claimsFooter]) {
      section.hidden = true;
    }
    clearBtn.hidden = true;
  }

  async function flashInspectedBlock(): Promise<void> {
    if (inspectedTabId === null || !inspectedTarget?.blockId) return;
    const selector = `[data-ht-inspect-id="${inspectedTarget.blockId}"]`;
    await chrome.scripting.executeScript({ target: { tabId: inspectedTabId }, func: flashBySelector, args: [selector] }).catch(() => {});
  }

  function renderPassage(target: InspectTarget): void {
    passageSection.hidden = false;
    passageSection.append(el("div", SECTION_LABEL, "Passage"));
    const excerpt = target.text.length > 360 ? `${target.text.slice(0, 360)}…` : target.text;
    const quote = el(
      "button",
      "text-left italic text-neutral-300 border-l-2 border-neutral-600 pl-2 hover:border-amber-500",
      `“${excerpt}”`,
    );
    quote.title = "Show it on the page";
    quote.addEventListener("click", flashInspectedBlock);
    const meta = [target.title, formatDate(target.publishedAt) ? `published ${formatDate(target.publishedAt)}` : undefined]
      .filter(Boolean)
      .join(" · ");
    passageSection.append(quote, el("div", "text-[11px] text-neutral-500", meta));
  }

  function renderProvisional(text: string): number {
    const sentences = splitSentences(text).slice(0, 8);
    if (!sentences.length) return 0;
    provisionalSection.hidden = false;
    provisionalSection.append(el("div", SECTION_LABEL, "First read · local heuristics, refining…"));
    for (const sentence of sentences) {
      const row = el("div", "flex gap-2 items-start text-neutral-400");
      row.append(
        el("span", `${CHIP} shrink-0 bg-neutral-900 text-neutral-400 border-neutral-700`, TYPE_LABELS[heuristicClaimType(sentence)]),
        el("span", "min-w-0", sentence.length > 160 ? `${sentence.slice(0, 160)}…` : sentence),
      );
      provisionalSection.appendChild(row);
    }
    return sentences.length;
  }

  function renderCard(claim: ClaimCard, n: number): HTMLElement {
    const { status: evidenceStatus, sources, notChecked, unsourcedAssessment } = claim.evidence;
    const card = el("div", "flex flex-col gap-2 rounded bg-neutral-800/70 border border-neutral-700 p-3 transition-shadow");

    const top = el("div", "flex gap-2 items-start");
    top.append(
      el(
        "span",
        `shrink-0 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full border-[1.5px] text-[10px] font-bold ${STATUS_BADGE[evidenceStatus]}`,
        String(n),
      ),
      el("div", "text-neutral-100 font-medium leading-snug", claim.claim),
    );
    card.appendChild(top);

    const chips = el("div", "flex flex-wrap gap-1.5");
    chips.append(
      el("span", `${CHIP} bg-neutral-900 text-neutral-300 border-neutral-600`, TYPE_LABELS[claim.type]),
      el("span", `${CHIP} ${STATUS_CHIP[evidenceStatus]}`, STATUS_LABELS[evidenceStatus]),
    );
    card.appendChild(chips);

    const quote = el("button", "text-left text-xs text-neutral-400 italic hover:text-neutral-200", `“${claim.quote}”`);
    quote.title = "Show it on the page";
    quote.addEventListener("click", flashInspectedBlock);
    card.appendChild(quote);

    const field = (label: string, value: string) => {
      const row = el("div", "text-xs text-neutral-300 leading-snug");
      row.append(el("span", "text-neutral-500", `${label}: `), document.createTextNode(value));
      return row;
    };
    card.appendChild(field("Stated source", claim.statedSource ?? "none — the page cites nothing for this"));
    if (claim.context) card.appendChild(field("Context", claim.context));

    if (claim.framingFlags.length) {
      const flags = el("div", "flex flex-col gap-1");
      for (const flag of claim.framingFlags) {
        const row = el("div", "text-xs leading-snug");
        row.append(el("span", "text-amber-300 font-medium", `⚑ ${FLAG_LABELS[flag.kind]}: `), el("span", "text-neutral-300", flag.note));
        flags.appendChild(row);
      }
      card.appendChild(flags);
    }

    const evidence = el("div", "flex flex-col gap-1");
    evidence.appendChild(el("div", SECTION_LABEL, "Page-cited links"));
    if (sources.length) {
      for (const source of sources) {
        const row = el("div", "flex gap-2 items-baseline text-xs");
        const link = el("a", "text-amber-400 underline hover:text-amber-300 break-words min-w-0", source.text);
        link.href = source.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = source.href;
        const tag = el("span", "shrink-0 text-[10px] text-neutral-500", "not externally verified");
        tag.title = "Offered by the page as backing; this is distinct from a source the Source Tracer checked.";
        row.append(link, tag);
        evidence.appendChild(row);
      }
    } else {
      evidence.appendChild(el("div", "text-xs text-neutral-400", "No source found."));
    }
    if (unsourcedAssessment) {
      evidence.appendChild(
        el(
          "div",
          "text-xs text-neutral-400 leading-snug",
          `Without a source, the model's read was “${STATUS_LABELS[unsourcedAssessment]}” — shown as Unverified until a source backs it.`,
        ),
      );
    }
    card.appendChild(evidence);

    const sourceContext = el("div", "flex flex-col gap-1");
    sourceContext.hidden = true;
    const external = el("div", "flex flex-col gap-1");
    external.append(
      el("div", SECTION_LABEL, "External verification"),
      el("div", "text-xs text-neutral-400", tracerConfigured ? "Checking external sources…" : "Not checked yet."),
    );
    sourceSections.set(claim.verifiedQuote, { context: sourceContext, external });
    card.append(sourceContext, external);

    card.appendChild(field("What we could not check", notChecked ?? "Whether the cited sources say what the page claims."));

    const actions = el("div", "flex gap-2 pt-1");
    const verify = el("button", `${BTN} text-xs`, "Verify ↗");
    if (sources.length) {
      verify.title = `Open ${sources[0].href}`;
      verify.addEventListener("click", () => window.open(sources[0].href, "_blank", "noopener,noreferrer"));
    } else {
      verify.disabled = true;
      verify.title = "No source to open";
    }
    const show = el("button", `${BTN} text-xs`, "Show on page");
    show.addEventListener("click", flashInspectedBlock);
    actions.append(verify, show);
    card.appendChild(actions);

    return card;
  }

  function renderVerifiedSources(
    quote: string,
    sources: VerifiedSource[],
    contexts: ContextSource[],
    notChecked?: string,
  ): void {
    const sections = sourceSections.get(quote);
    if (!sections) return;
    sections.context.hidden = contexts.length === 0;
    sections.context.replaceChildren(el("div", SECTION_LABEL, "Page context — not verification"));
    for (const context of contexts) {
      const row = el("div", "flex flex-col gap-0.5 text-xs");
      const link = el("a", "text-amber-300 underline hover:text-amber-200 break-words", context.title);
      link.href = context.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      row.append(
        link,
        el("div", "text-[10px] text-amber-300", sourceContextMessage(context.contextReasons)),
        el("div", "text-neutral-400 italic", `“${context.excerpt}”`),
      );
      sections.context.appendChild(row);
    }

    const section = sections.external;
    section.replaceChildren(el("div", SECTION_LABEL, "External verification"));
    if (!sources.length) {
      section.appendChild(el("div", "text-xs text-neutral-400", noExternalSourcesMessage(notChecked)));
      if (notChecked) {
        section.appendChild(
          el("div", "text-[10px] text-neutral-500", "This is not a finding about the claim; no external check ran."),
        );
      }
      return;
    }
    for (const source of sources) {
      const row = el("div", "flex flex-col gap-0.5 text-xs");
      const link = el("a", "text-emerald-300 underline hover:text-emerald-200 break-words", source.title);
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const qualityClass = source.sourceQuality === "institutional_signal" ? "text-emerald-400" : "text-amber-300";
      row.append(
        link,
        el("div", "text-[10px] text-emerald-400", "Exact quote verified on external source"),
        el("div", `text-[10px] ${qualityClass}`, sourceQualityMessage(source.sourceQuality)),
        el("div", "text-neutral-400 italic", `“${source.excerpt}”`),
      );
      section.appendChild(row);
    }
  }

  function renderAllSources(sources: SavedInspection["sources"] & object): void {
    const quotes = new Set([...Object.keys(sources.sourcesByQuote), ...Object.keys(sources.contextsByQuote)]);
    for (const quote of quotes) {
      renderVerifiedSources(
        quote,
        sources.sourcesByQuote[quote] ?? [],
        sources.contextsByQuote[quote] ?? [],
        sources.notCheckedByQuote[quote],
      );
    }
  }

  function renderSlop(report: SlopReport | undefined, note: string | undefined): void {
    slopSection.hidden = false;
    slopSection.replaceChildren(el("div", SECTION_LABEL, "Slop Check · GPTZero"));
    if (!report) {
      slopSection.appendChild(el("div", "text-xs text-neutral-400", note ?? "No result."));
      return;
    }
    const pct = Math.round(report.aiProbability * 100);
    const barColor = pct >= 70 ? "bg-red-400" : pct >= 40 ? "bg-amber-400" : "bg-emerald-400";
    const headline = el("div", "text-neutral-100", `${pct}% probability the passage is AI-written`);
    const track = el("div", "h-1.5 rounded bg-neutral-800 overflow-hidden");
    const fill = el("div", `h-full ${barColor}`);
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    const meta = el("div", "text-xs text-neutral-400", `Predicted: ${report.predictedClass} · confidence: ${report.confidence}`);
    slopSection.append(headline, track, meta);
    if (report.message) slopSection.appendChild(el("div", "text-xs text-neutral-400", report.message));
    if (report.sentences.length) {
      const flagged = report.sentences.filter((s) => s.aiProbability >= 0.5).length;
      slopSection.appendChild(
        el("div", "text-xs text-neutral-400", `${flagged} of ${report.sentences.length} sentences score 50% or higher.`),
      );
    }
    slopSection.appendChild(
      el("div", "text-[11px] text-neutral-500", "A probability from GPTZero, not proof of who wrote this passage."),
    );
  }

  async function renderClaims(claims: ClaimCard[], target: InspectTarget, tabId: number, myRun: number): Promise<void> {
    provisionalSection.hidden = true;
    claimsSection.hidden = false;
    claimsFooter.hidden = false;
    claimsSection.replaceChildren(el("div", SECTION_LABEL, `Claims · ${claims.length}`));
    if (!claims.length) {
      claimsSection.appendChild(el("div", "text-xs text-neutral-400", "No checkable claims in this passage."));
      return;
    }
    claims.forEach((claim, i) => {
      const card = renderCard(claim, i + 1);
      cards.set(i + 1, card);
      claimsSection.appendChild(card);
    });

    const started = performance.now();
    try {
      const [{ result: placed }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: markClaims,
        args: [target.blockId, claims.map((c, i) => ({ n: i + 1, quote: c.verifiedQuote, status: c.evidence.status }))],
      });
      if (myRun !== runId) return;
      addTrace("Page markers", "done", `${placed ?? 0} of ${claims.length} placed`, performance.now() - started);
      clearBtn.hidden = false;
    } catch (err) {
      if (myRun === runId) addTrace("Page markers", "failed", pageAccessError(err));
    }
  }

  async function inspectSelection(): Promise<void> {
    const myRun = ++runId;
    cancelInspect?.();
    cancelInspect = null;
    resetResults();

    let tabId: number;
    let target: InspectTarget | null;
    const started = performance.now();
    try {
      tabId = await getActiveTabId();
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: captureInspectTarget });
      target = injection?.result ?? null;
    } catch (err) {
      setStatus(pageAccessError(err));
      return;
    }
    if (myRun !== runId) return;
    if (!target) {
      setStatus("Select a sentence or paragraph on the page first (at least a few words), or use Pick paragraph.");
      return;
    }

    inspectedTabId = tabId;
    inspectedTarget = target;
    tracerConfigured = (await getSourceTracerUrl()) !== null;
    if (myRun !== runId) return;
    addTrace(
      "Capture (page)",
      "done",
      `${wordCount(target.text)} words · ${target.links.length} link${target.links.length === 1 ? "" : "s"}`,
      performance.now() - started,
    );
    renderPassage(target);

    const localStart = performance.now();
    const sentenceCount = renderProvisional(target.text);
    addTrace("First read (local heuristics)", "done", `${sentenceCount} sentences`, performance.now() - localStart);

    setStatus("Analyzing…");
    const capturedTarget = target;
    cancelInspect = startInspect(target, {
      onTrace: (m: InspectTrace) => {
        if (myRun === runId) addTrace(m.step, m.state, m.detail, m.ms);
      },
      onClaims: (m) => {
        if (myRun !== runId) return;
        if (m.error || !m.claims) {
          claimsSection.hidden = false;
          claimsSection.replaceChildren(el("div", "text-xs text-red-300", m.error ?? "Couldn't analyze this passage."));
          provisionalSection.querySelector("div")?.replaceChildren("First read · local heuristics only");
          return;
        }
        saved = { tabId, target: capturedTarget, claims: m.claims };
        persistInspection();
        void renderClaims(m.claims, capturedTarget, tabId, myRun);
      },
      onSlop: (m) => {
        if (myRun !== runId) return;
        renderSlop(m.report, m.note);
        if (saved) {
          saved.slop = { report: m.report, note: m.note };
          persistInspection();
        }
      },
      onSources: (m) => {
        if (myRun !== runId) return;
        renderAllSources(m);
        if (saved) {
          saved.sources = {
            sourcesByQuote: m.sourcesByQuote,
            contextsByQuote: m.contextsByQuote,
            notCheckedByQuote: m.notCheckedByQuote,
          };
          persistInspection();
        }
      },
      onDone: () => {
        if (myRun !== runId) return;
        cancelInspect = null;
        setStatus(cards.size ? `Done — ${cards.size} claim${cards.size === 1 ? "" : "s"}. Click a badge on the page to jump to its card.` : "Done.");
      },
    });
  }

  async function togglePick(): Promise<void> {
    if (pickTabId !== null) {
      const tabId = pickTabId;
      setPicking(null);
      await chrome.scripting.executeScript({ target: { tabId }, func: stopPickMode }).catch(() => {});
      setStatus("Picking cancelled.");
      return;
    }
    try {
      const tabId = await getActiveTabId();
      await chrome.scripting.executeScript({ target: { tabId }, func: startPickMode });
      setPicking(tabId);
      setStatus("Hover the page — claim-bearing sentences get underlined. Click a paragraph to inspect it; Esc cancels.");
    } catch (err) {
      setStatus(pageAccessError(err));
    }
  }

  async function clearMarks(): Promise<void> {
    runId++;
    cancelInspect?.();
    cancelInspect = null;
    if (inspectedTabId !== null) {
      await chrome.scripting.executeScript({ target: { tabId: inspectedTabId }, func: clearClaimMarks }).catch(() => {});
    }
    inspectedTarget = null;
    forgetInspection();
    resetResults();
    setStatus("Cleared.");
  }

  /**
   * Rebuilds the last inspection after the side panel was closed and reopened, then re-places the
   * page badges so their click handlers point at the cards that now exist.
   */
  async function restoreInspection(): Promise<void> {
    const stored = await chrome.storage.session.get(INSPECTION_KEY);
    const previous = stored[INSPECTION_KEY] as SavedInspection | undefined;
    if (!previous?.claims?.length) return;
    if (runId !== 0 || inspectedTarget) return; // the reader already started something newer

    saved = previous;
    inspectedTabId = previous.tabId;
    inspectedTarget = previous.target;
    tracerConfigured = (await getSourceTracerUrl()) !== null;

    renderPassage(previous.target);
    await renderClaims(previous.claims, previous.target, previous.tabId, runId);
    if (previous.slop) renderSlop(previous.slop.report, previous.slop.note);
    if (previous.sources) renderAllSources(previous.sources);
    setStatus(`Showing your last inspection — ${previous.claims.length} claim${previous.claims.length === 1 ? "" : "s"}.`);
  }

  pickBtn.addEventListener("click", togglePick);
  inspectBtn.addEventListener("click", inspectSelection);
  clearBtn.addEventListener("click", clearMarks);
  onActiveTabChange(() => void watchActiveSelection());
  void watchActiveSelection();

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return;
    const fromTab = sender.tab.id;
    if (message?.type === "HT_SELECTION" && fromTab === selectionTabId) {
      setCanInspect(message.hasSelection === true);
    } else if (message?.type === "HT_PICKED" && fromTab === pickTabId) {
      setPicking(null);
      options.activate();
      setMode("claims");
      void inspectSelection();
    } else if (message?.type === "HT_PICK_CANCELLED" && fromTab === pickTabId) {
      setPicking(null);
      setStatus("Picking cancelled.");
    } else if (message?.type === "HT_CLAIM_CLICK" && fromTab === inspectedTabId) {
      const card = cards.get(Number(message.n));
      if (!card) return;
      options.activate();
      setMode("claims");
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("ring-2", "ring-amber-500");
      setTimeout(() => card.classList.remove("ring-2", "ring-amber-500"), 1400);
    }
  });

  // ---- Outline view ---------------------------------------------------------------------------
  const outlineToolbar = el("div", "flex flex-wrap gap-2 items-center");
  const outlineBtn = el("button", BTN_PRIMARY, "Outline this page");
  const showOnPageLabel = el("label", "flex items-center gap-2 text-neutral-300 text-xs");
  const showOnPage = el("input");
  showOnPage.type = "checkbox";
  showOnPage.disabled = true;
  showOnPageLabel.append(showOnPage, el("span", "", "Show labels on page"));
  outlineToolbar.append(outlineBtn, showOnPageLabel);

  const outlineStatus = el(
    "p",
    "text-xs text-neutral-500 min-h-[1em]",
    "Labels each block of the page as important, supporting, boilerplate, navigation or ad, as a tree.",
  );
  const legend = el("div", "flex flex-wrap gap-1.5");
  const tree = el("div", "flex flex-col font-mono text-xs");
  const outlineFooter = el(
    "p",
    "text-[11px] text-neutral-500 border-t border-neutral-800 pt-3",
    "What we could not check: text inside iframes and images isn't read, and labels come from each block's " +
      "text plus page-structure signals — a reading, not a guarantee.",
  );
  outlineFooter.hidden = true;
  outlineView.append(outlineToolbar, outlineStatus, legend, tree, outlineFooter);

  let outlineRun = 0;
  let outlineTabId: number | null = null;
  let outlineBlocks: OutlineBlock[] = [];
  const hiddenLabels = new Set<OutlineLabel>();

  function renderOutline(): void {
    const counts = new Map<OutlineLabel, number>();
    for (const b of outlineBlocks) counts.set(b.label, (counts.get(b.label) ?? 0) + 1);

    legend.replaceChildren();
    for (const label of OUTLINE_ORDER) {
      const count = counts.get(label);
      if (!count) continue;
      const hidden = hiddenLabels.has(label);
      const chip = el("button", `${CHIP} ${OUTLINE_CHIP[label]} ${hidden ? "opacity-40 line-through" : ""}`, `${OUTLINE_LABEL_TEXT[label]} ${count}`);
      chip.title = hidden ? "Show these blocks" : "Hide these blocks";
      chip.addEventListener("click", () => {
        if (hidden) hiddenLabels.delete(label);
        else hiddenLabels.add(label);
        renderOutline();
      });
      legend.appendChild(chip);
    }

    tree.replaceChildren();
    for (const block of outlineBlocks) {
      if (hiddenLabels.has(block.label)) continue;
      const row = el(
        "button",
        "flex items-center gap-2 w-full text-left py-1 pr-1 rounded hover:bg-neutral-800 min-w-0",
      );
      row.style.paddingLeft = `${4 + block.depth * 14}px`;
      row.title = block.text;
      const isHeading = /^h[1-6]$/.test(block.tag);
      row.append(
        el("span", "shrink-0 text-neutral-500", `<${block.tag}>`),
        el("span", `${CHIP} shrink-0 font-sans ${OUTLINE_CHIP[block.label]}`, OUTLINE_LABEL_TEXT[block.label]),
        el("span", `truncate font-sans ${isHeading ? "text-neutral-100 font-medium" : "text-neutral-300"}`, block.text),
      );
      row.addEventListener("click", () => {
        if (outlineTabId === null) return;
        const selector = `[data-ht-outline-id="${block.id}"]`;
        void chrome.scripting.executeScript({ target: { tabId: outlineTabId }, func: flashBySelector, args: [selector] }).catch(() => {});
      });
      tree.appendChild(row);
    }
  }

  async function syncLabelsToPage(): Promise<void> {
    if (outlineTabId === null) return;
    const labels = outlineBlocks.map((b) => ({ id: b.id, label: b.label }));
    await chrome.scripting
      .executeScript({ target: { tabId: outlineTabId }, func: applyOutlineLabels, args: [labels, showOnPage.checked] })
      .catch(() => {});
  }

  async function buildOutline(): Promise<void> {
    const myRun = ++outlineRun;
    outlineBtn.disabled = true;
    outlineStatus.textContent = "Reading the page…";
    try {
      if (outlineTabId !== null && showOnPage.checked) {
        // Remove the previous page's outlines before re-reading.
        await chrome.scripting
          .executeScript({ target: { tabId: outlineTabId }, func: applyOutlineLabels, args: [[], false] })
          .catch(() => {});
      }
      const tabId = await getActiveTabId();
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractOutline });
      if (myRun !== outlineRun) return;
      if (!result || !result.blocks.length) {
        outlineStatus.textContent = "No readable blocks found on this page.";
        outlineBlocks = [];
        renderOutline();
        return;
      }

      outlineTabId = tabId;
      outlineBlocks = result.blocks;
      showOnPage.disabled = false;
      outlineFooter.hidden = false;
      renderOutline();
      await syncLabelsToPage();

      const toLabel = outlineBlocks.filter((b) => !b.fixed);
      if (!toLabel.length) {
        outlineStatus.textContent = `${outlineBlocks.length} blocks.`;
        return;
      }
      outlineStatus.textContent = `${outlineBlocks.length} blocks · first-pass labels from page structure, refining…`;
      const reply = await requestOutlineLabels(
        result.title,
        toLabel.map((b) => ({ id: b.id, tag: b.tag, text: b.text })),
      );
      if (myRun !== outlineRun) return;
      if (reply.error || !reply.labels) {
        outlineStatus.textContent = `${outlineBlocks.length} blocks · labels are from page structure only (${reply.error ?? "no reply"}).`;
        return;
      }

      const refined = new Map(reply.labels.map((l) => [l.id, l.label]));
      outlineBlocks = outlineBlocks.map((b) => {
        const label = refined.get(b.id);
        return b.fixed || !label ? b : { ...b, label };
      });
      renderOutline();
      await syncLabelsToPage();
      const important = outlineBlocks.filter((b) => b.label === "important").length;
      outlineStatus.textContent = `${outlineBlocks.length} blocks · ${important} important. Click a row to find it on the page.`;
    } catch (err) {
      if (myRun === outlineRun) outlineStatus.textContent = pageAccessError(err);
    } finally {
      if (myRun === outlineRun) outlineBtn.disabled = false;
    }
  }

  outlineBtn.addEventListener("click", buildOutline);
  showOnPage.addEventListener("change", () => void syncLabelsToPage());

  void restoreInspection();
}
