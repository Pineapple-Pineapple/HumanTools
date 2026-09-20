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
import type { TraceState } from "../lib/messages";
import { getActiveTabId } from "../lib/active-tab";
import { createTabStore, getCurrentTabId, onTabActivated, onTabClosed, onTabLoaded, onTabNavigated } from "../lib/tab-state";
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
import {
  ATTENTION_CHIP,
  BODY,
  BTN,
  BTN_PRIMARY,
  CHIP,
  H1,
  LINK_BTN,
  NEUTRAL_CHIP,
  NOTE,
  SECTION_LABEL,
  SMALL_BTN,
  STATUS,
  el,
  pageAccessError,
} from "./ui";

// ---- Card vocabulary. Every chip carries its definition as a tooltip; there is no glossary. ----

const TYPE_LABELS: Record<ClaimType, string> = {
  fact: "Fact",
  opinion: "Opinion",
  speculation: "Speculation",
  prediction: "Prediction",
  quote: "Quote",
};

const TYPE_HELP: Record<ClaimType, string> = {
  fact: "Stated as something that is the case and could be checked.",
  opinion: "A judgment or preference; not checkable as such.",
  speculation: "Hedged — may, might, could, reportedly.",
  prediction: "About the future; not checkable yet.",
  quote: "Attributed to someone. What to check is whether they said it.",
};

const STATUS_LABELS: Record<EvidenceStatus, string> = {
  supported: "Supported",
  partly_supported: "Partly supported",
  unverified: "Unverified",
  contradicted: "Contradicted",
};

const STATUS_HELP: Record<EvidenceStatus, string> = {
  supported:
    "The model's reading: a link the page cites backs the claim as stated. The link was not opened — only the Source Tracer checks external pages.",
  partly_supported:
    "The model's reading: a link the page cites backs part of the claim; the rest goes beyond it or is worded more strongly.",
  unverified: "Nothing on the page backs this claim, so no verdict is given. Not a finding that the claim is wrong.",
  contradicted: "The model's reading: a link the page cites says otherwise. The link was not opened.",
};

const STATUS_CHIP: Record<EvidenceStatus, string> = {
  supported: `${CHIP} bg-emerald-950 text-emerald-300 border-emerald-800`,
  partly_supported: ATTENTION_CHIP,
  unverified: NEUTRAL_CHIP,
  contradicted: `${CHIP} bg-red-950 text-red-300 border-red-800`,
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

const FLAG_HELP: Record<FramingFlagKind, string> = {
  base_effect: "A large percentage change measured from a small starting point; the absolute change may be small.",
  cherry_picked_window: "The time span was chosen to make the trend look its best or worst.",
  missing_denominator: "A count with no total behind it — a thousand out of how many?",
  relative_vs_absolute: "A relative change (doubled, 50% more) without the absolute numbers, or the reverse.",
  loaded_wording: "Word choice that carries a judgment the evidence does not.",
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
  important: ATTENTION_CHIP,
  supporting: NEUTRAL_CHIP,
  boilerplate: `${CHIP} bg-neutral-900 text-muted border-neutral-700`,
  navigation: `${CHIP} bg-sky-950 text-sky-300 border-sky-800`,
  advertisement: `${CHIP} bg-red-950 text-red-300 border-red-800`,
};

const TRACE_ICON: Record<TraceState, string> = { running: "…", done: "✓", skipped: "–", failed: "✕" };
const TRACE_ICON_CLASS: Record<TraceState, string> = {
  running: "text-amber-400",
  done: "text-emerald-400",
  skipped: "text-muted",
  failed: "text-red-400",
};

const CLAIMS_HINT = "Pick a paragraph on the page, or select some text and press Inspect selection.";
const NO_SELECTION_HINT = "Select a sentence or paragraph on the page first (at least a few words).";
const RUNNING_HINT = "An inspection is still running on this tab — wait for it to finish, or press Clear.";
const OUTLINE_HINT =
  "Labels each block of the page as important, supporting, boilerplate, navigation or ad, as a tree.";

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

/** Session-storage key holding every tab's finished inspection, keyed by tab id. */
const INSPECTION_KEY = "inspection";

/** One step of the pipeline as the trace shows it. Keyed by `step`; a later entry replaces an earlier. */
export interface TraceEntry {
  step: string;
  state: TraceState;
  detail?: string;
  ms?: number;
}

/** Replaces the entry for `entry.step`, or appends it. Steps keep the order they first appeared in. */
export function upsertTrace(list: TraceEntry[], entry: TraceEntry): void {
  const i = list.findIndex((e) => e.step === entry.step);
  if (i === -1) list.push(entry);
  else list[i] = entry;
}

/**
 * One tab's inspection, from the moment its run starts. `claims` is empty until extraction
 * answers; `error` is set instead when it fails. Only records with claims are mirrored to session
 * storage, so a run that dies with the panel leaves no half-result behind to be restored.
 */
interface SavedInspection {
  tabId: number;
  target: InspectTarget;
  claims: ClaimCard[];
  error?: string;
  slop?: { report?: SlopReport; note?: string };
  sources?: {
    sourcesByQuote: Record<string, VerifiedSource[]>;
    contextsByQuote: Record<string, ContextSource[]>;
    notCheckedByQuote: Record<string, string>;
  };
  trace: TraceEntry[];
}

/** An inspection in flight. A new object per run, so identity says whether a callback is stale. */
interface Run {
  record: SavedInspection;
  cancel: () => void;
}

function chip(className: string, text: string, help: string): HTMLSpanElement {
  const node = el("span", className, text);
  node.title = help;
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

function externalLink(className: string, text: string, href: string): HTMLAnchorElement {
  const link = el("a", className, text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
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
  header.appendChild(el("h1", H1, "Inspector — what am I looking at?"));
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
  toolbar.append(pickBtn, inspectBtn, clearBtn);

  const status = el("p", STATUS, CLAIMS_HINT);
  const optionsLink = el("button", LINK_BTN, "Set API key");
  optionsLink.addEventListener("click", () => chrome.runtime.openOptionsPage());

  const passageSection = el("div", "flex flex-col gap-1.5");
  const provisionalSection = el("div", "flex flex-col gap-1.5");
  const provisionalLabel = el("div", SECTION_LABEL);
  const slopSection = el("div", "flex flex-col gap-1.5");
  const claimsSection = el("div", "flex flex-col gap-3");
  const traceDetails = el("details", "text-xs text-neutral-400");
  const traceSummary = el("summary", "cursor-pointer select-none text-muted hover:text-neutral-300", "Trace");
  const traceList = el("div", "flex flex-col gap-1 mt-2");
  traceDetails.append(traceSummary, traceList);
  const claimsFooter = el(
    "p",
    `${NOTE} border-t border-neutral-800 pt-3`,
    "A matching source is evidence only when it is a distinct eligible external page. Text found on this page is context, not verification. " +
      "Finding nothing is not a finding against the claim.",
  );
  claimsView.append(
    toolbar,
    status,
    optionsLink,
    passageSection,
    provisionalSection,
    claimsSection,
    slopSection,
    traceDetails,
    claimsFooter,
  );

  /** Discards a superseded render, so rapid tab switching can't interleave two of them. */
  let showRun = 0;
  /** Which tab's inspection the claims view is showing — what the page's badges must match. */
  let shownTabId: number | null = null;
  /** Whether a Source Tracer endpoint is set, so cards don't claim to be checking when nothing will. */
  let tracerConfigured = false;
  let pickTabId: number | null = null;
  /** The tab whose HT_SELECTION reports drive the Inspect selection button, and its last report. */
  let selectionTabId: number | null = null;
  let hasSelection = false;
  const cards = new Map<number, HTMLElement>();
  const sourceSections = new Map<string, { context: HTMLElement; external: HTMLElement }>();
  const traceRows = new Map<string, HTMLElement>();

  /** Inspections by tab, live from the moment a run starts. Evicted by tab-state on navigation or close. */
  const inspections = createTabStore<SavedInspection>();
  /**
   * Runs in flight, by tab. A run on one tab never touches another's: the money is spent the
   * moment a run starts (the service worker finishes the call whether or not anyone is listening),
   * so the only honest thing to do with its result is keep it for the tab it belongs to.
   */
  const runs = new Map<number, Run>();
  /**
   * Every tab's finished inspection, mirrored to session storage. Closing the side panel destroys
   * the panel's JS context, and with it the card map the page's claim badges message back into —
   * so without this, every badge on the page goes dead the moment the panel is reopened.
   */
  const persisted = new Map<number, SavedInspection>();

  function writePersisted(): void {
    void chrome.storage.session.set({ [INSPECTION_KEY]: Object.fromEntries(persisted) });
  }

  /** Mirrors a record with claims. Until a run's claims land, the tab's previous copy stays. */
  function persistInspection(record: SavedInspection): void {
    if (!record.claims.length) return;
    persisted.set(record.tabId, record);
    writePersisted();
  }

  function forgetInspection(tabId: number): void {
    inspections.forget(tabId);
    persisted.delete(tabId);
    writePersisted();
  }

  function stopRun(tabId: number): void {
    runs.get(tabId)?.cancel();
    runs.delete(tabId);
  }

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

  /**
   * Pick and Inspect are off while this tab has a run going: a second run would be a second paid
   * call for the same passage, and the first one's result would be thrown away. Clear is the way out.
   */
  function updateToolbar(): void {
    const running = shownTabId !== null && runs.has(shownTabId);
    pickBtn.disabled = running;
    pickBtn.title = running ? RUNNING_HINT : "";
    inspectBtn.disabled = running || !hasSelection;
    inspectBtn.title = running ? RUNNING_HINT : hasSelection ? "" : NO_SELECTION_HINT;
    clearBtn.hidden = !running && passageSection.hidden;
    clearBtn.title = running ? "Stop this inspection and clear its results" : "Remove this tab's results and page badges";
  }

  /**
   * Starts listening to a tab's selection; the watcher reports straight back via HT_SELECTION, and
   * again whenever the selection changes. Re-run on every switch and load: an injected script does
   * not survive a navigation, and only the tab in front of the reader drives the button.
   */
  async function watchSelectionOn(tabId: number): Promise<void> {
    hasSelection = false;
    selectionTabId = tabId;
    updateToolbar();
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: watchSelection });
    } catch {
      // Pages the extension can't script (chrome://, the Web Store) never have an inspectable selection.
    }
  }

  function setPicking(tabId: number | null): void {
    pickTabId = tabId;
    pickLabel.textContent = tabId === null ? "Pick paragraph" : "Cancel picking";
  }

  function renderTraceRow(entry: TraceEntry): void {
    traceDetails.hidden = false;
    let row = traceRows.get(entry.step);
    if (!row) {
      row = el("div", "flex gap-2 items-baseline");
      traceRows.set(entry.step, row);
      traceList.appendChild(row);
    }
    const icon = el("span", `w-3 shrink-0 text-center ${TRACE_ICON_CLASS[entry.state]}`, TRACE_ICON[entry.state]);
    const name = el("span", "text-neutral-300 shrink-0", entry.step);
    const parts = [entry.detail, entry.ms !== undefined ? formatMs(entry.ms) : undefined].filter(Boolean).join(" · ");
    const info = el("span", "text-muted min-w-0 break-words", parts);
    row.replaceChildren(icon, name, info);
  }

  function renderTrace(entries: TraceEntry[]): void {
    traceRows.clear();
    traceList.replaceChildren();
    traceDetails.hidden = !entries.length;
    for (const entry of entries) renderTraceRow(entry);
  }

  /** Records a step against its inspection, and draws it when that inspection is the one on screen. */
  function trace(record: SavedInspection, entry: TraceEntry, draw: boolean): void {
    upsertTrace(record.trace, entry);
    if (draw) renderTraceRow(entry);
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
    updateToolbar();
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
    const published = formatDate(target.publishedAt);
    const meta = [target.title, published ? `published ${published}` : undefined].filter(Boolean).join(" · ");
    passageSection.append(quote, el("div", NOTE, meta));
  }

  function renderProvisional(text: string): number {
    const sentences = splitSentences(text).slice(0, 8);
    if (!sentences.length) return 0;
    provisionalSection.hidden = false;
    provisionalLabel.textContent = "First read · local heuristics, refining…";
    provisionalSection.append(provisionalLabel);
    for (const sentence of sentences) {
      const row = el("div", "flex gap-2 items-start text-neutral-400");
      const type = heuristicClaimType(sentence);
      row.append(
        chip(`${NEUTRAL_CHIP} shrink-0`, TYPE_LABELS[type], TYPE_HELP[type]),
        el("span", "min-w-0", sentence.length > 160 ? `${sentence.slice(0, 160)}…` : sentence),
      );
      provisionalSection.appendChild(row);
    }
    return sentences.length;
  }

  function renderCard(claim: ClaimCard, n: number, pending: boolean): HTMLElement {
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
      chip(NEUTRAL_CHIP, TYPE_LABELS[claim.type], TYPE_HELP[claim.type]),
      chip(STATUS_CHIP[evidenceStatus], STATUS_LABELS[evidenceStatus], STATUS_HELP[evidenceStatus]),
    );
    card.appendChild(chips);

    const quote = el("button", "text-left text-xs text-neutral-400 italic hover:text-neutral-200", `“${claim.quote}”`);
    quote.title = "Show it on the page";
    quote.addEventListener("click", flashInspectedBlock);
    card.appendChild(quote);

    const field = (label: string, value: string) => {
      const row = el("div", BODY);
      row.append(el("span", "text-muted", `${label}: `), document.createTextNode(value));
      return row;
    };
    card.appendChild(field("Stated source", claim.statedSource ?? "none — the page cites nothing for this"));
    if (claim.context) card.appendChild(field("Context", claim.context));

    if (claim.framingFlags.length) {
      const flags = el("div", "flex flex-col gap-1");
      for (const flag of claim.framingFlags) {
        const row = el("div", "text-xs leading-snug");
        const name = el("span", "text-amber-300 font-medium", `⚑ ${FLAG_LABELS[flag.kind]}: `);
        name.title = FLAG_HELP[flag.kind];
        row.append(name, el("span", "text-neutral-300", flag.note));
        flags.appendChild(row);
      }
      card.appendChild(flags);
    }

    const evidence = el("div", "flex flex-col gap-1");
    evidence.appendChild(el("div", SECTION_LABEL, "Page-cited links"));
    if (sources.length) {
      for (const source of sources) {
        const row = el("div", "flex gap-2 items-baseline text-xs");
        const link = externalLink("text-amber-400 underline hover:text-amber-300 break-words min-w-0", source.text, source.href);
        link.title = source.href;
        const tag = el("span", "shrink-0 text-[10px] text-muted", "not externally verified");
        tag.title = "Offered by the page as backing; this is distinct from a source the Source Tracer checked.";
        row.append(link, tag);
        evidence.appendChild(row);
      }
    } else {
      evidence.appendChild(el("div", "text-xs text-neutral-400", "The page links to nothing for this claim."));
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
    // A restored record with no sources belongs to a run that never finished — say so, rather
    // than leaving "Checking…" on screen for a check that will never come back.
    const placeholder = pending
      ? tracerConfigured
        ? "Checking external sources…"
        : "Not checked yet."
      : noExternalSourcesMessage("the inspection did not finish.");
    external.append(el("div", SECTION_LABEL, "External verification"), el("div", "text-xs text-neutral-400", placeholder));
    sourceSections.set(claim.verifiedQuote, { context: sourceContext, external });
    card.append(sourceContext, external);

    card.appendChild(field("What we could not check", notChecked ?? "Whether the cited sources say what the page claims."));

    const actions = el("div", "flex gap-2 pt-1");
    const open = el("button", SMALL_BTN, "Open cited link ↗");
    if (sources.length) {
      open.title = `Open ${sources[0].href}`;
      open.addEventListener("click", () => window.open(sources[0].href, "_blank", "noopener,noreferrer"));
    } else {
      open.disabled = true;
      open.title = "The page cites no link for this claim";
    }
    const show = el("button", SMALL_BTN, "Show on page");
    show.addEventListener("click", flashInspectedBlock);
    actions.append(open, show);
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
      row.append(
        externalLink("text-amber-300 underline hover:text-amber-200 break-words", context.title, context.url),
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
        section.appendChild(el("div", "text-[10px] text-muted", "This is not a finding about the claim; no external check ran."));
      }
      return;
    }
    for (const source of sources) {
      const row = el("div", "flex flex-col gap-0.5 text-xs");
      const qualityClass = source.sourceQuality === "institutional_signal" ? "text-emerald-400" : "text-amber-300";
      row.append(
        externalLink("text-emerald-300 underline hover:text-emerald-200 break-words", source.title, source.url),
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
    slopSection.appendChild(el("div", NOTE, "A probability from GPTZero, not proof of who wrote this passage."));
  }

  function doneStatus(claimCount: number): string {
    return claimCount ? `${claimCount} claim${claimCount === 1 ? "" : "s"}. Click a badge on the page to jump to its card.` : "Done.";
  }

  /**
   * Draws the claims section for `record`: its error, its cards, or nothing yet while extraction
   * is still running (the first read stands in). Fills the `cards` map the page's badges resolve
   * through; returns whether there are cards for badges to point at.
   */
  function renderCards(record: SavedInspection, tabId: number): boolean {
    if (record.error) {
      provisionalLabel.textContent = "First read · local heuristics only";
      claimsSection.hidden = false;
      claimsSection.replaceChildren(el("div", "text-xs text-red-300", record.error));
      return false;
    }
    const pending = runs.get(tabId)?.record === record;
    if (pending && !record.claims.length) return false;
    provisionalSection.hidden = true;
    claimsSection.hidden = false;
    claimsFooter.hidden = false;
    claimsSection.replaceChildren(el("div", SECTION_LABEL, `Claims · ${record.claims.length}`));
    if (!record.claims.length) {
      claimsSection.appendChild(el("div", "text-xs text-neutral-400", "No checkable claims in this passage."));
      return false;
    }
    record.claims.forEach((claim, i) => {
      const card = renderCard(claim, i + 1, pending);
      cards.set(i + 1, card);
      claimsSection.appendChild(card);
    });
    return true;
  }

  /**
   * Places the page's numbered badges against the cards just drawn. Cards and badges are always
   * rebuilt together — here, right after `renderCards` — so a badge's number can never outlive
   * the card it opens. `stillMine` says whether the panel still shows what this call drew.
   */
  async function placeMarkers(record: SavedInspection, tabId: number, stillMine: () => boolean): Promise<void> {
    const started = performance.now();
    let entry: TraceEntry;
    try {
      const [{ result: placed }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: markClaims,
        args: [record.target.blockId, record.claims.map((c, i) => ({ n: i + 1, quote: c.verifiedQuote, status: c.evidence.status }))],
      });
      entry = {
        step: "Page markers",
        state: "done",
        detail: `${placed ?? 0} of ${record.claims.length} placed`,
        ms: performance.now() - started,
      };
    } catch (err) {
      entry = { step: "Page markers", state: "failed", detail: pageAccessError(err, "inspected") };
    }
    if (!stillMine()) return;
    trace(record, entry, true);
  }

  /**
   * Extracts claims from the reader's selection. Paid, and it needs a selection, so it only ever
   * runs from a deliberate gesture — never from a tab switch. Nothing on screen changes until the
   * capture has succeeded: an empty selection or an unscriptable page just reports itself.
   */
  async function inspectSelection(): Promise<void> {
    let tabId: number;
    let target: InspectTarget | null;
    const started = performance.now();
    try {
      tabId = await getActiveTabId();
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: captureInspectTarget });
      target = injection?.result ?? null;
    } catch (err) {
      setStatus(pageAccessError(err, "inspected"));
      return;
    }
    // Nothing has been spent yet — the capture is local. If the reader has already moved to another
    // tab, stop here rather than paying for a passage they have left behind.
    if (!isCurrentTab(tabId)) return;
    if (!target) {
      setStatus("Select a sentence or paragraph on the page first (at least a few words), or use Pick paragraph.");
      return;
    }
    if (runs.has(tabId)) {
      setStatus(RUNNING_HINT);
      return;
    }

    const record: SavedInspection = { tabId, target, claims: [], trace: [] };
    const run: Run = { record, cancel: () => {} };
    // Registered before anything awaits, so a second gesture can't slip in and start a second run.
    runs.set(tabId, run);
    // The tab's previous inspection stays in session storage until this run's claims replace it: if
    // the run dies with the panel, reopening restores the badges the page still shows, not nothing.
    inspections.set(tabId, record);
    const current = () => runs.get(tabId) === run;
    const draw = () => current() && onShownTab(tabId);

    showRun++;
    shownTabId = tabId;
    resetResults();
    if (pickTabId === tabId) void stopPicking();
    trace(
      record,
      {
        step: "Capture (page)",
        state: "done",
        detail: `${wordCount(target.text)} words · ${target.links.length} link${target.links.length === 1 ? "" : "s"}`,
        ms: performance.now() - started,
      },
      true,
    );
    renderPassage(target);
    const localStart = performance.now();
    const sentenceCount = renderProvisional(target.text);
    trace(
      record,
      { step: "First read (local heuristics)", state: "done", detail: `${sentenceCount} sentences`, ms: performance.now() - localStart },
      true,
    );
    setStatus("Analyzing…");
    updateToolbar();

    // Results are always recorded against the tab they belong to — the spend already happened, so
    // a reader who wandered off mid-run still finds them waiting on the way back. Only the drawing
    // is conditional on that tab still being the one in front of them.
    run.cancel = startInspect(target, {
      onTrace: (m) => {
        if (current()) trace(record, { step: m.step, state: m.state, detail: m.detail, ms: m.ms }, draw());
      },
      onClaims: (m) => {
        if (!current()) return;
        if (m.error || !m.claims) record.error = m.error ?? "Couldn't analyze this passage.";
        else {
          record.claims = m.claims;
          persistInspection(record);
        }
        if (!draw()) return;
        // This is the newest view of this tab; abandon any swap-in still resolving, or the cards
        // would be drawn twice.
        const mine = ++showRun;
        if (renderCards(record, tabId)) void placeMarkers(record, tabId, () => mine === showRun);
      },
      onSlop: (m) => {
        if (!current()) return;
        record.slop = { report: m.report, note: m.note };
        persistInspection(record);
        if (draw()) renderSlop(m.report, m.note);
      },
      onSources: (m) => {
        if (!current()) return;
        record.sources = { sourcesByQuote: m.sourcesByQuote, contextsByQuote: m.contextsByQuote, notCheckedByQuote: m.notCheckedByQuote };
        persistInspection(record);
        if (draw()) renderAllSources(record.sources);
      },
      onDone: () => {
        if (!current()) return;
        runs.delete(tabId);
        persistInspection(record);
        if (!onShownTab(tabId)) return;
        setStatus(doneStatus(cards.size));
        updateToolbar();
      },
      onDisconnect: () => {
        // The service worker went away mid-run. Whatever landed stays; the reader is told rather
        // than left on "Analyzing…" with Clear as the only way out.
        if (!current()) return;
        const lost = "Lost the connection to the extension before this finished.";
        if (!record.claims?.length) record.error = lost;
        runs.delete(tabId);
        persistInspection(record);
        if (!onShownTab(tabId)) return;
        setStatus(record.claims?.length ? `${doneStatus(cards.size)} ${lost}` : lost);
        updateToolbar();
      },
    });

    tracerConfigured = (await getSourceTracerUrl()) !== null;
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
      setStatus(pageAccessError(err, "inspected"));
    }
  }

  /** Drops the shown tab's inspection — its run if one is going, its record, and the page's badges. */
  async function clearMarks(): Promise<void> {
    const tabId = shownTabId;
    if (tabId === null) return;
    showRun++;
    stopRun(tabId);
    await chrome.scripting.executeScript({ target: { tabId }, func: clearClaimMarks }).catch(() => {});
    forgetInspection(tabId);
    resetResults();
    setStatus("Cleared.");
  }

  /**
   * Puts `tabId`'s inspection on screen — finished, still running, or failed — or a clean empty
   * state if it has none. Runs on a tab switch, a navigation, a reload, and when the panel is
   * reopened with results still in session storage.
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
    void watchSelectionOn(tabId);
    resetResults();
    showOutline(tabId);

    let record = inspections.get(tabId) ?? persisted.get(tabId) ?? null;
    if (record) {
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
        stopRun(tabId);
        forgetInspection(tabId);
        record = null;
      }
    }
    if (!record) {
      setStatus(CLAIMS_HINT);
      return;
    }

    tracerConfigured = (await getSourceTracerUrl()) !== null;
    if (mine !== showRun) return;

    const pending = runs.get(tabId)?.record === record;
    renderPassage(record.target);
    if (!record.claims.length && (pending || record.error)) renderProvisional(record.target.text);
    renderTrace(record.trace);
    if (record.slop) renderSlop(record.slop.report, record.slop.note);
    const hasCards = renderCards(record, tabId);
    if (record.sources) renderAllSources(record.sources);
    setStatus(pending ? "Analyzing…" : doneStatus(record.claims.length));
    updateToolbar();
    if (hasCards) await placeMarkers(record, tabId, () => mine === showRun);
  }

  pickBtn.addEventListener("click", togglePick);
  inspectBtn.addEventListener("click", inspectSelection);
  clearBtn.addEventListener("click", clearMarks);

  // A badge on the page is only live while that tab's cards are the ones on screen. `shownTabId`
  // is the whole badge-to-card contract: same tab, same `cards` map, same numbering.
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return;
    const fromTab = sender.tab.id;
    if (message?.type === "HT_SELECTION" && fromTab === selectionTabId) {
      hasSelection = message.hasSelection === true;
      updateToolbar();
    } else if (message?.type === "HT_PICKED" && fromTab === pickTabId) {
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

  const outlineStatus = el("p", STATUS, OUTLINE_HINT);
  const legend = el("div", "flex flex-wrap gap-1.5");
  const tree = el("div", "flex flex-col font-mono text-xs");
  const outlineFooter = el(
    "p",
    `${NOTE} border-t border-neutral-800 pt-3`,
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

  const outlines = createTabStore<OutlineState>();
  /** Tabs with a build going. One per tab, and a build on one tab never touches another's. */
  const outlineBusy = new Set<number>();

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
      const toggle = el("button", `${OUTLINE_CHIP[label]} ${off ? "opacity-40 line-through" : ""}`, `${OUTLINE_LABEL_TEXT[label]} ${count}`);
      toggle.title = off ? "Show these blocks" : "Hide these blocks";
      toggle.addEventListener("click", () => {
        if (off) hidden.delete(label);
        else hidden.add(label);
        renderOutline(tabId);
      });
      legend.appendChild(toggle);
    }

    tree.replaceChildren();
    for (const block of blocks) {
      if (hidden.has(block.label)) continue;
      const row = el("button", "flex items-center gap-2 w-full text-left py-1 pr-1 rounded hover:bg-neutral-800 min-w-0");
      row.style.paddingLeft = `${4 + block.depth * 14}px`;
      row.title = block.text;
      const isHeading = /^h[1-6]$/.test(block.tag);
      row.append(
        el("span", "shrink-0 text-muted", `<${block.tag}>`),
        el("span", `${OUTLINE_CHIP[block.label]} shrink-0 font-sans`, OUTLINE_LABEL_TEXT[block.label]),
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
    const busy = tabId !== null && outlineBusy.has(tabId);
    showOnPage.checked = state?.showOnPage ?? false;
    showOnPage.disabled = !state;
    outlineFooter.hidden = !state;
    outlineBtn.disabled = busy;
    outlineStatus.textContent = state?.status || (busy ? "Reading the page…" : OUTLINE_HINT);
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
    let tabId: number;
    try {
      tabId = getCurrentTabId() ?? (await getActiveTabId());
    } catch (err) {
      outlineStatus.textContent = pageAccessError(err, "outlined");
      return;
    }
    if (outlineBusy.has(tabId)) return;
    outlineBusy.add(tabId);
    if (isCurrentTab(tabId)) outlineBtn.disabled = true;
    try {
      const previous = outlines.get(tabId);
      if (previous?.showOnPage) {
        // Take the old outlines off this page before re-reading it.
        await chrome.scripting
          .executeScript({ target: { tabId }, func: applyOutlineLabels, args: [[], false] })
          .catch(() => {});
      }
      if (isCurrentTab(tabId)) outlineStatus.textContent = "Reading the page…";

      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractOutline });
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
      if (outlines.get(tabId) !== state) return;
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
      if (isCurrentTab(tabId)) outlineStatus.textContent = pageAccessError(err, "outlined");
    } finally {
      outlineBusy.delete(tabId);
      if (isCurrentTab(tabId)) outlineBtn.disabled = false;
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

  onTabLoaded((tabId) => {
    // A reload keeps the URL, so nothing evicted this tab's inspection — but the fresh document
    // has no badges in it, and no selection watcher either. Redraw cards and badges together.
    if (onShownTab(tabId) && inspections.get(tabId)?.claims.length) void showTab(tabId);
    else void watchSelectionOn(tabId);
  });

  onTabNavigated((tabId) => {
    // The page all of this was about is gone. Call off a run still going for it rather than
    // showing the rest of it against a passage that no longer exists, and drop the stored copy so
    // reopening the panel can't resurrect it.
    stopRun(tabId);
    forgetInspection(tabId);
    void showTab(tabId);
  });

  // An inspection outlives the panel, but not the tab it describes. Closing the tab takes the page
  // with it, so the copy in session storage has nothing left to be about.
  onTabClosed((tabId) => {
    stopRun(tabId);
    forgetInspection(tabId);
  });

  void (async () => {
    // Inspections survive the panel closing; each is checked against its tab's current page before
    // it is shown, in showTab.
    const stored = await chrome.storage.session.get(INSPECTION_KEY);
    const byTab = stored[INSPECTION_KEY] as Record<string, SavedInspection> | undefined;
    // A tab closed while the panel was shut had nobody listening for it, and Chrome hands tab ids
    // out again, so anything without a live tab is dropped here rather than kept for the session.
    const live = new Set((await chrome.tabs.query({})).map((tab) => tab.id));
    let dropped = false;
    for (const [key, record] of Object.entries(byTab ?? {})) {
      const tabId = Number(key);
      if (!Number.isInteger(tabId) || !record?.claims?.length) continue;
      if (!live.has(tabId)) {
        dropped = true;
        continue;
      }
      persisted.set(tabId, { ...record, trace: record.trace ?? [] });
    }
    if (dropped) writePersisted();
    try {
      await showTab(getCurrentTabId() ?? (await getActiveTabId()));
    } catch {
      // No tab to attach to yet; the first tab event will bring one.
    }
  })();
}
