import {
  applyOutlineLabels,
  captureInspectTarget,
  clearClaimMarks,
  extractOutline,
  flashBySelector,
  markClaims,
  startPickMode,
  stopPickMode,
} from "../content/functions";
import { requestOutlineLabels, startInspect } from "../lib/messages";
import type { InspectTrace, TraceState } from "../lib/messages";
import { getActiveTabId } from "../lib/active-tab";
import { createTabStore, getCurrentTabId, onTabActivated, onTabNavigated } from "../lib/tab-state";
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

/**
 * Whether two URLs address the same document. A stored inspection is only still worth showing if
 * its tab is on the page it was taken from; moving within a page (a fragment) is not leaving it.
 */
export function isSameDocument(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.split("#")[0] === b.split("#")[0];
}

const CLAIMS_HINT = "Pick a paragraph on the page, or select some text and press Inspect selection.";
const OUTLINE_HINT =
  "Labels each block of the page as important, supporting, boilerplate, navigation or ad, as a tree.";

/** Session-storage key holding every tab's finished inspection, keyed by tab id. */
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
  const clearBtn = el("button", BTN, "Clear");
  clearBtn.hidden = true;
  toolbar.append(pickBtn, inspectBtn, clearBtn);

  const status = el("p", "text-xs text-neutral-500 min-h-[1em]", CLAIMS_HINT);

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

  /** Discards a superseded inspection run. */
  let runId = 0;
  /** The tab the in-flight inspection is about, so a navigation there can call it off. */
  let runTabId: number | null = null;
  /** Discards a superseded render, so rapid tab switching can't interleave two of them. */
  let showRun = 0;
  let cancelInspect: (() => void) | null = null;
  /** Inspections by tab. Evicted by tab-state when a tab navigates or closes. */
  const inspections = createTabStore<SavedInspection>();
  /** Which tab's inspection the claims view is showing — what the page's badges must match. */
  let shownTabId: number | null = null;
  /** Whether a Source Tracer endpoint is set, so cards don't claim to be checking when nothing will. */
  let tracerConfigured = false;
  /**
   * Every tab's finished inspection, mirrored to session storage. Closing the side panel destroys
   * the panel's JS context, and with it the card map the page's claim badges message back into —
   * so without this, every badge on the page goes dead the moment the panel is reopened.
   */
  const persisted = new Map<number, SavedInspection>();

  function writePersisted(): void {
    void chrome.storage.session.set({ [INSPECTION_KEY]: Object.fromEntries(persisted) });
  }

  function persistInspection(record: SavedInspection): void {
    persisted.set(record.tabId, record);
    writePersisted();
  }

  function forgetInspection(tabId: number): void {
    inspections.forget(tabId);
    persisted.delete(tabId);
    writePersisted();
  }
  let pickTabId: number | null = null;
  const cards = new Map<number, HTMLElement>();
  const sourceSections = new Map<string, { context: HTMLElement; external: HTMLElement }>();
  const traceRows = new Map<string, HTMLElement>();

  function setStatus(text: string): void {
    status.textContent = text;
  }

  /**
   * Whether `tabId` is the tab in front of the reader. A null answer from tab-state means it hasn't
   * resolved the starting tab yet — nothing has moved, so the tab we looked up is still the one.
   */
  function isCurrentTab(tabId: number): boolean {
    const current = getCurrentTabId();
    return current === null || current === tabId;
  }

  /** Whether `tabId` is both the tab whose results are on screen and the tab the reader is on. */
  function onShownTab(tabId: number): boolean {
    return shownTabId === tabId && isCurrentTab(tabId);
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

  /** Flashes the inspected block on the tab whose cards are on screen — never on another tab's page. */
  async function flashInspectedBlock(): Promise<void> {
    const tabId = shownTabId;
    if (tabId === null || !isCurrentTab(tabId)) return;
    const blockId = inspections.get(tabId)?.target.blockId;
    if (!blockId) return;
    const selector = `[data-ht-inspect-id="${blockId}"]`;
    await chrome.scripting.executeScript({ target: { tabId }, func: flashBySelector, args: [selector] }).catch(() => {});
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

  /**
   * Extracts claims from the reader's selection. Paid, and it needs a selection, so it only ever
   * runs from a deliberate gesture — never from a tab switch.
   */
  async function inspectSelection(): Promise<void> {
    const myRun = ++runId;
    showRun++;
    cancelInspect?.();
    cancelInspect = null;
    runTabId = null;
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
    // Nothing has been spent yet — the capture is local. If the reader has already moved to another
    // tab, stop here rather than paying for a passage they have left behind.
    if (myRun !== runId || !isCurrentTab(tabId)) return;
    shownTabId = tabId;
    if (!target) {
      setStatus("Select a sentence or paragraph on the page first (at least a few words), or use Pick paragraph.");
      return;
    }

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
    runTabId = tabId;
    cancelInspect = startInspect(target, {
      onTrace: (m: InspectTrace) => {
        // A trace belongs to one run on one tab; it must never open a trace panel over another's.
        if (myRun === runId && onShownTab(tabId)) addTrace(m.step, m.state, m.detail, m.ms);
      },
      // Results are always recorded against the tab they belong to — the spend already happened,
      // so a reader who wandered off mid-run still finds them waiting on the way back. Only the
      // rendering is conditional on that tab still being the one in front of them.
      onClaims: (m) => {
        if (myRun !== runId) return;
        if (m.error || !m.claims) {
          if (!onShownTab(tabId)) return;
          claimsSection.hidden = false;
          claimsSection.replaceChildren(el("div", "text-xs text-red-300", m.error ?? "Couldn't analyze this passage."));
          provisionalSection.querySelector("div")?.replaceChildren("First read · local heuristics only");
          return;
        }
        const record: SavedInspection = { tabId, target: capturedTarget, claims: m.claims };
        inspections.set(tabId, record);
        persistInspection(record);
        if (!onShownTab(tabId)) return;
        // This is the newest view of this tab; abandon any swap-in still resolving, or the cards
        // would be drawn twice.
        showRun++;
        void renderClaims(m.claims, capturedTarget, tabId, myRun);
      },
      onSlop: (m) => {
        if (myRun !== runId) return;
        const record = inspections.get(tabId);
        if (record) {
          record.slop = { report: m.report, note: m.note };
          persistInspection(record);
        }
        if (onShownTab(tabId)) renderSlop(m.report, m.note);
      },
      onSources: (m) => {
        if (myRun !== runId) return;
        const record = inspections.get(tabId);
        if (record) {
          record.sources = {
            sourcesByQuote: m.sourcesByQuote,
            contextsByQuote: m.contextsByQuote,
            notCheckedByQuote: m.notCheckedByQuote,
          };
          persistInspection(record);
        }
        if (onShownTab(tabId)) renderAllSources(m);
      },
      onDone: () => {
        if (myRun !== runId) return;
        cancelInspect = null;
        runTabId = null;
        if (!onShownTab(tabId)) return;
        setStatus(cards.size ? `Done — ${cards.size} claim${cards.size === 1 ? "" : "s"}. Click a badge on the page to jump to its card.` : "Done.");
      },
    });
  }

  /** Takes the page out of pick mode, wherever it was armed. */
  async function stopPicking(): Promise<void> {
    const tabId = pickTabId;
    if (tabId === null) return;
    setPicking(null);
    await chrome.scripting.executeScript({ target: { tabId }, func: stopPickMode }).catch(() => {});
  }

  async function togglePick(): Promise<void> {
    if (pickTabId !== null) {
      await stopPicking();
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
    const tabId = shownTabId;
    if (tabId === null) return;
    runId++;
    showRun++;
    cancelInspect?.();
    cancelInspect = null;
    runTabId = null;
    await chrome.scripting.executeScript({ target: { tabId }, func: clearClaimMarks }).catch(() => {});
    forgetInspection(tabId);
    resetResults();
    setStatus("Cleared.");
  }

  /**
   * Puts `tabId`'s inspection on screen, or a clean empty state if it has none — on a tab switch,
   * on a navigation, and when the panel is reopened with results still in session storage.
   *
   * Re-running `markClaims` here is what keeps the page's numbered badges working: the card
   * elements are rebuilt from scratch on every swap-in, so the badges have to be re-placed against
   * the `cards` map that now exists. Skip that and every badge on the page points at nothing.
   *
   * Nothing paid runs from here. Claim extraction needs a selection and a deliberate press.
   */
  async function showTab(tabId: number): Promise<void> {
    const mine = ++showRun;
    shownTabId = tabId;
    resetResults();
    showOutline(tabId);

    let record = inspections.get(tabId) ?? persisted.get(tabId) ?? null;
    if (record?.claims?.length) {
      // Valid only while the tab is still on the page it was taken from. In memory tab-state has
      // usually dropped it already; from session storage nothing has checked yet, and a tab that
      // navigated while the panel was closed must not get its old results handed back.
      const url = await chrome.tabs
        .get(tabId)
        .then((tab) => tab.url)
        .catch(() => undefined);
      if (mine !== showRun) return;
      if (isSameDocument(url, record.target.url)) inspections.set(tabId, record);
      else {
        forgetInspection(tabId);
        record = null;
      }
    } else {
      record = null;
    }

    if (!record) {
      setStatus(CLAIMS_HINT);
      return;
    }

    tracerConfigured = (await getSourceTracerUrl()) !== null;
    if (mine !== showRun) return;

    renderPassage(record.target);
    await renderClaims(record.claims, record.target, tabId, runId);
    if (mine !== showRun) return;
    if (record.slop) renderSlop(record.slop.report, record.slop.note);
    if (record.sources) renderAllSources(record.sources);
    setStatus(
      `${record.claims.length} claim${record.claims.length === 1 ? "" : "s"}. Click a badge on the page to jump to its card.`,
    );
  }

  pickBtn.addEventListener("click", togglePick);
  inspectBtn.addEventListener("click", inspectSelection);
  clearBtn.addEventListener("click", clearMarks);

  // A badge on the page is only live while that tab's cards are the ones on screen. `shownTabId`
  // is the whole badge-to-card contract: same tab, same `cards` map, same numbering.
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return;
    const fromTab = sender.tab.id;
    if (message?.type === "HT_PICKED" && fromTab === pickTabId) {
      setPicking(null);
      options.activate();
      setMode("claims");
      void inspectSelection();
    } else if (message?.type === "HT_PICK_CANCELLED" && fromTab === pickTabId) {
      setPicking(null);
      setStatus("Picking cancelled.");
    } else if (message?.type === "HT_CLAIM_CLICK" && fromTab === shownTabId) {
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

  const outlineStatus = el("p", "text-xs text-neutral-500 min-h-[1em]", OUTLINE_HINT);
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

  /** One tab's outline. Evicted by tab-state when that tab navigates or closes. */
  interface OutlineState {
    blocks: OutlineBlock[];
    hidden: Set<OutlineLabel>;
    showOnPage: boolean;
    status: string;
  }

  let outlineRun = 0;
  /** The tab an outline build is running for, so the button only reads busy on that tab. */
  let outlineBusyTabId: number | null = null;
  const outlines = createTabStore<OutlineState>();

  function setOutlineStatus(tabId: number, text: string): void {
    const state = outlines.get(tabId);
    if (state) state.status = text;
    if (isCurrentTab(tabId)) outlineStatus.textContent = text;
  }

  function renderOutline(tabId: number | null): void {
    const state = outlines.get(tabId);
    const blocks = state?.blocks ?? [];
    const hidden = state?.hidden ?? new Set<OutlineLabel>();

    const counts = new Map<OutlineLabel, number>();
    for (const b of blocks) counts.set(b.label, (counts.get(b.label) ?? 0) + 1);

    legend.replaceChildren();
    for (const label of OUTLINE_ORDER) {
      const count = counts.get(label);
      if (!count) continue;
      const off = hidden.has(label);
      const chip = el("button", `${CHIP} ${OUTLINE_CHIP[label]} ${off ? "opacity-40 line-through" : ""}`, `${OUTLINE_LABEL_TEXT[label]} ${count}`);
      chip.title = off ? "Show these blocks" : "Hide these blocks";
      chip.addEventListener("click", () => {
        if (off) hidden.delete(label);
        else hidden.add(label);
        renderOutline(tabId);
      });
      legend.appendChild(chip);
    }

    tree.replaceChildren();
    for (const block of blocks) {
      if (hidden.has(block.label)) continue;
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
        // Rows only ever belong to the tab on screen; this keeps a stale one from reaching elsewhere.
        if (tabId === null || !isCurrentTab(tabId)) return;
        const selector = `[data-ht-outline-id="${block.id}"]`;
        void chrome.scripting.executeScript({ target: { tabId }, func: flashBySelector, args: [selector] }).catch(() => {});
      });
      tree.appendChild(row);
    }
  }

  /** Puts `tabId`'s outline on screen, or the empty state. Never starts a build — that one is paid. */
  function showOutline(tabId: number | null): void {
    const state = outlines.get(tabId);
    showOnPage.checked = state?.showOnPage ?? false;
    showOnPage.disabled = !state;
    outlineFooter.hidden = !state;
    outlineBtn.disabled = tabId !== null && outlineBusyTabId === tabId;
    outlineStatus.textContent = state?.status || OUTLINE_HINT;
    renderOutline(tabId);
  }

  async function syncLabelsToPage(tabId: number): Promise<void> {
    const state = outlines.get(tabId);
    if (!state) return;
    const labels = state.blocks.map((b) => ({ id: b.id, label: b.label }));
    await chrome.scripting
      .executeScript({ target: { tabId }, func: applyOutlineLabels, args: [labels, state.showOnPage] })
      .catch(() => {});
  }

  /**
   * Reads the page and labels every block. The refinement pass is an LLM call, so this only ever
   * runs from a press of "Outline this page" — switching to a tab shows what it already has.
   */
  async function buildOutline(): Promise<void> {
    const myRun = ++outlineRun;
    let tabId: number | null = null;
    try {
      tabId = getCurrentTabId() ?? (await getActiveTabId());
      outlineBusyTabId = tabId;
      outlineBtn.disabled = true;

      const previous = outlines.get(tabId);
      if (previous?.showOnPage) {
        // Take the old outlines off this page before re-reading it.
        await chrome.scripting
          .executeScript({ target: { tabId }, func: applyOutlineLabels, args: [[], false] })
          .catch(() => {});
      }
      if (isCurrentTab(tabId)) outlineStatus.textContent = "Reading the page…";

      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractOutline });
      if (myRun !== outlineRun) return;
      if (!result || !result.blocks.length) {
        outlines.forget(tabId);
        if (isCurrentTab(tabId)) {
          showOutline(tabId);
          outlineStatus.textContent = "No readable blocks found on this page.";
        }
        return;
      }

      const state: OutlineState = {
        blocks: result.blocks,
        hidden: previous?.hidden ?? new Set<OutlineLabel>(),
        showOnPage: previous?.showOnPage ?? false,
        status: "",
      };
      outlines.set(tabId, state);
      if (isCurrentTab(tabId)) showOutline(tabId);
      await syncLabelsToPage(tabId);

      const toLabel = state.blocks.filter((b) => !b.fixed);
      if (!toLabel.length) {
        setOutlineStatus(tabId, `${state.blocks.length} blocks.`);
        return;
      }
      setOutlineStatus(tabId, `${state.blocks.length} blocks · first-pass labels from page structure, refining…`);

      const reply = await requestOutlineLabels(
        result.title,
        toLabel.map((b) => ({ id: b.id, tag: b.tag, text: b.text })),
      );
      // A gone state means the tab navigated or closed mid-call: the labels describe a page that
      // is no longer there, so they are dropped rather than shown against whatever replaced it.
      if (myRun !== outlineRun || outlines.get(tabId) !== state) return;
      if (reply.error || !reply.labels) {
        setOutlineStatus(tabId, `${state.blocks.length} blocks · labels are from page structure only (${reply.error ?? "no reply"}).`);
        return;
      }

      const refined = new Map(reply.labels.map((l) => [l.id, l.label]));
      state.blocks = state.blocks.map((b) => {
        const label = refined.get(b.id);
        return b.fixed || !label ? b : { ...b, label };
      });
      if (isCurrentTab(tabId)) renderOutline(tabId);
      await syncLabelsToPage(tabId);
      const important = state.blocks.filter((b) => b.label === "important").length;
      setOutlineStatus(tabId, `${state.blocks.length} blocks · ${important} important. Click a row to find it on the page.`);
    } catch (err) {
      if (myRun === outlineRun && (tabId === null || isCurrentTab(tabId))) {
        outlineStatus.textContent = pageAccessError(err);
      }
    } finally {
      if (myRun === outlineRun) {
        outlineBusyTabId = null;
        outlineBtn.disabled = false;
      }
    }
  }

  outlineBtn.addEventListener("click", buildOutline);
  showOnPage.addEventListener("change", () => {
    const tabId = getCurrentTabId();
    const state = outlines.get(tabId);
    if (tabId === null || !state) return;
    state.showOnPage = showOnPage.checked;
    void syncLabelsToPage(tabId);
  });

  // ---- Following the reader ---------------------------------------------------------------------
  onTabActivated((tabId) => {
    // Picking is a gesture on the page in front of you; it doesn't follow the reader to another.
    if (pickTabId !== null && pickTabId !== tabId) void stopPicking();
    void showTab(tabId);
  });

  onTabNavigated((tabId) => {
    // The page all of this was about is gone. Call off a run still going for it rather than
    // spending the rest of it on a passage that no longer exists, and drop the stored copy so
    // reopening the panel can't resurrect it.
    if (runTabId === tabId) {
      runId++;
      cancelInspect?.();
      cancelInspect = null;
      runTabId = null;
    }
    forgetInspection(tabId);
    void showTab(tabId);
  });

  void (async () => {
    // Inspections survive the panel closing; each is checked against its tab's current page before
    // it is shown, in showTab.
    const stored = await chrome.storage.session.get(INSPECTION_KEY);
    const byTab = stored[INSPECTION_KEY] as Record<string, SavedInspection> | undefined;
    for (const [key, record] of Object.entries(byTab ?? {})) {
      const tabId = Number(key);
      if (Number.isInteger(tabId) && record?.claims?.length) persisted.set(tabId, record);
    }
    try {
      await showTab(getCurrentTabId() ?? (await getActiveTabId()));
    } catch {
      // No tab to attach to yet; the first tab event will bring one.
    }
  })();
}
