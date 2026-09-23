import { computeFleschKincaidGrade } from "../lib/flesch-kincaid";
import {
  applyRewrites,
  captureSelectedBlock,
  extractPageBlocks,
  markTargets,
  restoreOriginal,
  startPickMode,
  stopPickMode,
  watchSelection,
} from "../content/functions";
import { startRewrite } from "../lib/messages";
import { getActiveTabId, isActiveTab } from "../lib/active-tab";
import { createTabStore, getCurrentTabId, onTabActivated, onTabLoaded, onTabNavigated } from "../lib/tab-state";
import { whenVisible } from "../lib/panel-visibility";
import { hasApiKey } from "../lib/provider";
import { BTN, BTN_PRIMARY, H1, LINK_BTN, SECTION_LABEL, STATUS, el, pageAccessError } from "./ui";
import type { Block, Grade, PageModel, RewriteFormat } from "../lib/types";

const GRADE_STEPS: Grade[] = [6, 8, 10, 12];
const DEFAULT_GRADE: Grade = 8;
const TAB_MOVED = "The tab in front of you changed — switch back and try again.";
/** Tags this panel's crosshair, so the Inspector's picks and cancels are not mistaken for ours. */
const PICK_SOURCE = "accessibility";
/** Only paragraphs extraction has stamped light up: exactly the set the rewrite pipeline can patch. */
const PICK_SELECTOR = "p[data-ht-block-id]";
const PICK_HINT =
  "Hover the page — rewritable paragraphs light up. Click to add or remove one; keep clicking to build a set. Esc when you're done.";
const SCOPE_ON = "px-3 py-1.5 bg-neutral-700 text-neutral-100";
const SCOPE_OFF = "px-3 py-1.5 text-neutral-400 hover:text-neutral-200 disabled:opacity-40 disabled:hover:text-neutral-400";
const NO_SELECTION_HINT = "Select some text inside a paragraph on the page first.";
/** How much of a targeted paragraph the chip shows before it is cut off. */
const TARGET_PREVIEW_CHARS = 90;

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** A provider error as it reads inside a sentence: no trailing full stop of its own. */
function reason(lastError: string | null): string | null {
  const trimmed = lastError?.trim().replace(/\.$/, "");
  return trimmed || null;
}

/**
 * The status line while paragraphs stream in. A failure says why, not just that it happened.
 * A rewrite aimed at one targeted paragraph has no progress to count, so it says what it is doing.
 */
export function rewriteProgress(
  done: number,
  total: number,
  failed: number,
  lastError: string | null,
  targeted = false,
): string {
  const base = targeted ? "Rewriting this paragraph…" : `Rewriting… ${done}/${total} paragraphs`;
  if (failed === 0) return base;
  const why = reason(lastError);
  return `${base} (${failed} failed${why ? `: ${why}` : ""})`;
}

/** The status line once the rewrite is over. Only promises a hover when something was rewritten. */
export function rewriteSummary(
  succeeded: number,
  failed: number,
  grade: Grade,
  lastError: string | null,
  targeted = false,
): string {
  const total = succeeded + failed;
  const why = reason(lastError);
  const failure = why ? `: ${why}.` : ".";
  // One targeted paragraph is named, not counted: "1 of 1 paragraphs" reads like a page that
  // mostly failed, and the hover it promises is on that paragraph rather than anywhere.
  if (targeted) {
    return succeeded === 0
      ? `Couldn't rewrite this paragraph${failure}`
      : `Rewrote this paragraph at grade ${grade}. Hover it to see the original.`;
  }
  if (succeeded === 0) return `Couldn't rewrite any of the ${plural(total, "paragraph")}${failure}`;
  const outcome =
    failed === 0
      ? `Rewrote ${plural(succeeded, "paragraph")} at grade ${grade}.`
      : `Rewrote ${succeeded} of ${total} paragraphs at grade ${grade}; ${failed} failed${failure}`;
  return `${outcome} Hover a paragraph to see the original.`;
}

/**
 * A paragraph the reader pointed at, either with the crosshair or by selecting text inside it.
 * `text` is the anchor it is re-found by, not the text to rewrite: a paragraph that has been
 * rewritten no longer reads as it did when it was targeted.
 */
export interface PickTarget {
  blockId: string;
  text: string;
  /** Whether the page says this paragraph currently carries a rewrite. */
  rewritten?: boolean;
}

/**
 * Re-finds a targeted paragraph in a freshly read page, or null when it is gone.
 *
 * Extraction stamps ids by index, so an id alone is not identity: insert a paragraph above the
 * target and `ht-b4` now names its neighbour. The text is the anchor — except for a paragraph
 * carrying a rewrite, whose text has changed for a reason the panel knows about, and which is
 * therefore trusted by id.
 */
export function resolveTarget(target: PickTarget, blocks: readonly Block[]): Block | null {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const anchor = normalize(target.text);

  const byId = blocks.find((b) => b.id === target.blockId);
  if (byId && (target.rewritten || normalize(byId.text) === anchor)) return byId;

  // The ids slid out from under it; the paragraph itself is still on the page.
  return blocks.find((b) => normalize(b.text) === anchor) ?? null;
}

/**
 * Re-finds every targeted paragraph in a freshly read page, dropping the ones that are gone.
 *
 * A paragraph the page says carries a rewrite keeps the anchor text it was targeted by — that is
 * what it will have to be re-found by again if it is ever restored. Two targets that resolve to the
 * same paragraph collapse into one, so a set built by clicking and by selecting can't rewrite the
 * same paragraph twice in one run.
 */
export function resolveTargets(
  targets: readonly PickTarget[],
  blocks: readonly Block[],
  rewrittenIds: readonly string[],
): PickTarget[] {
  const resolved: PickTarget[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const rewritten = rewrittenIds.includes(target.blockId);
    const block = resolveTarget({ ...target, rewritten }, blocks);
    if (!block || seen.has(block.id)) continue;
    seen.add(block.id);
    resolved.push({ blockId: block.id, text: rewritten ? target.text : block.text, rewritten });
  }
  return resolved;
}

/**
 * The status line after Stop. The port closes from this side, which Chrome never reports back
 * (see messages.ts), so this is the panel's own account of what it left behind rather than
 * something the rewrite told it.
 */
export function rewriteStopped(landed: number, total: number): string {
  if (landed === 0) return "Stopped before any paragraph was rewritten.";
  const survivors =
    landed === 1
      ? "The one that landed is still on the page — Restore original puts it back."
      : `The ${landed} that landed are still on the page — Restore original puts them back.`;
  return `Stopped after ${landed} of ${total} paragraphs. ${survivors}`;
}

/** The Rewrite button's label. The count goes on the thing you press, not only near it. */
export function rewriteButtonLabel(count: number): string {
  return `Rewrite ${plural(count, "paragraph")}`;
}

/** A targeted paragraph as the chip shows it: one line, cut off rather than wrapped forever. */
export function targetPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= TARGET_PREVIEW_CHARS ? collapsed : `${collapsed.slice(0, TARGET_PREVIEW_CHARS).trimEnd()}…`;
}

/** The Inspector's crosshair, so both pickers read as the same gesture. */
function crosshairIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "13");
  svg.setAttribute("height", "13");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("aria-hidden", "true");
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", "8");
  circle.setAttribute("cy", "8");
  circle.setAttribute("r", "3.25");
  const lines = document.createElementNS("http://www.w3.org/2000/svg", "path");
  lines.setAttribute("d", "M8 1v2.25M8 12.75V15M1 8h2.25M12.75 8H15");
  lines.setAttribute("stroke-linecap", "round");
  svg.append(circle, lines);
  return svg;
}

interface AccessibilityPanelEls {
  gradeNumber: HTMLElement;
  gradeLabel: HTMLElement;
  gradeChange: HTMLElement;
  pageGradeNote: HTMLElement;
  pickBtn: HTMLButtonElement;
  pickLabel: HTMLElement;
  selectionBtn: HTMLButtonElement;
  targetsSection: HTMLElement;
  targetList: HTMLElement;
  targetsLabel: HTMLElement;
  clearTargetsBtn: HTMLButtonElement;
  pageScopeBtn: HTMLButtonElement;
  selectedScopeBtn: HTMLButtonElement;
  gradeSlider: HTMLInputElement;
  gradeValue: HTMLElement;
  bulletsCheckbox: HTMLInputElement;
  rewriteBtn: HTMLButtonElement;
  restoreBtn: HTMLButtonElement;
  status: HTMLElement;
  optionsLink: HTMLButtonElement;
}

function renderAccessibilityPanel(container: HTMLElement): AccessibilityPanelEls {
  const root = el("div", "p-4 flex flex-col gap-4 text-sm");
  const heading = el("h1", H1, "Accessibility — make this understandable");

  // The panel's headline. Scoring is local and free, so the number is read off the page as soon as
  // the panel is shown rather than waiting to be asked for.
  const gradeGroup = el("div", "flex flex-col gap-0.5");
  const gradeNumber = el("div", "text-3xl leading-none font-semibold text-neutral-100 tabular-nums", "—");
  // The label moves with the number: once a paragraph is targeted, the headline is about that
  // paragraph, and the page's own grade steps down to the line beneath so neither is ambiguous.
  const gradeLabel = el("p", SECTION_LABEL, "Reading grade");
  const pageGradeNote = el("p", "text-xs text-muted");
  pageGradeNote.hidden = true;
  const gradeChange = el("p", "text-xs text-amber-400");
  gradeChange.hidden = true;
  gradeGroup.append(gradeNumber, gradeLabel, pageGradeNote, gradeChange);

  // Targeting is free and local, so both gestures sit above the paid control rather than beside it.
  const pickRow = el("div", "flex flex-wrap gap-2");
  const pickBtn = el("button", BTN);
  const pickLabel = el("span", "", "Pick paragraph");
  pickBtn.append(crosshairIcon(), pickLabel);
  pickBtn.disabled = true;
  const selectionBtn = el("button", BTN, "Use selection");
  selectionBtn.disabled = true;
  pickRow.append(pickBtn, selectionBtn);

  const targetsSection = el("div", "flex flex-col gap-1.5");
  const targetsHeader = el("div", "flex items-center justify-between gap-2");
  const targetsLabel = el("div", SECTION_LABEL, "Target paragraphs");
  const clearTargetsBtn = el("button", "text-xs text-amber-500 hover:underline disabled:opacity-40", "Clear all");
  targetsHeader.append(targetsLabel, clearTargetsBtn);
  const targetList = el("div", "flex flex-col gap-1");
  targetsSection.append(targetsHeader, targetList);
  targetsSection.hidden = true;

  const rewriteGroup = el("div", "flex flex-col gap-3 pt-3 border-t border-neutral-800");

  // Scope is a thing you can see and set, never inferred from an empty target list. "Whole page"
  // is a choice the reader can read off the screen before pressing a button that spends per paragraph.
  const scopeRow = el("div", "flex flex-col gap-1");
  const scopeSwitch = el("div", "inline-flex self-start rounded border border-neutral-700 overflow-hidden text-xs");
  const pageScopeBtn = el("button", SCOPE_ON, "Whole page");
  const selectedScopeBtn = el("button", SCOPE_OFF, "Selected");
  selectedScopeBtn.disabled = true;
  scopeSwitch.append(pageScopeBtn, selectedScopeBtn);
  scopeRow.append(el("div", SECTION_LABEL, "Scope"), scopeSwitch);

  const gradeRow = el("div", "flex flex-col gap-1");
  const gradeLabelRow = el("div", "flex items-center justify-between text-neutral-300");
  const gradeValue = el("span", "text-neutral-100 font-medium", String(DEFAULT_GRADE));
  gradeLabelRow.append(el("span", "", "Rewrite for grade"), gradeValue);

  const gradeSlider = el("input", "w-full accent-amber-600");
  gradeSlider.type = "range";
  gradeSlider.min = "6";
  gradeSlider.max = "12";
  gradeSlider.step = "2";
  gradeSlider.value = String(DEFAULT_GRADE);
  gradeSlider.disabled = true;

  const ticksRow = el("div", "flex justify-between text-xs text-muted px-0.5");
  for (const grade of GRADE_STEPS) ticksRow.appendChild(el("span", "", String(grade)));
  gradeRow.append(gradeLabelRow, gradeSlider, ticksRow);

  const bulletsRow = el("label", "flex items-center gap-2 text-neutral-300");
  const bulletsCheckbox = el("input");
  bulletsCheckbox.type = "checkbox";
  bulletsCheckbox.disabled = true;
  bulletsRow.append(bulletsCheckbox, el("span", "", "Convert to bullet points"));

  const actionRow = el("div", "flex gap-2");
  const rewriteBtn = el("button", BTN_PRIMARY, "Rewrite");
  rewriteBtn.disabled = true;
  const restoreBtn = el("button", BTN, "Restore original");
  restoreBtn.hidden = true;
  actionRow.append(rewriteBtn, restoreBtn);

  const status = el("p", STATUS);
  const optionsLink = el("button", LINK_BTN, "Set API key");

  rewriteGroup.append(scopeRow, gradeRow, bulletsRow, actionRow, status, optionsLink);
  root.append(heading, gradeGroup, pickRow, targetsSection, rewriteGroup);
  container.appendChild(root);

  return {
    gradeNumber,
    gradeLabel,
    gradeChange,
    pageGradeNote,
    pickBtn,
    pickLabel,
    selectionBtn,
    targetsSection,
    targetList,
    targetsLabel,
    clearTargetsBtn,
    pageScopeBtn,
    selectedScopeBtn,
    gradeSlider,
    gradeValue,
    bulletsCheckbox,
    rewriteBtn,
    restoreBtn,
    status,
    optionsLink,
  };
}

export function mountAccessibilityPanel(container: HTMLElement): void {
  const els = renderAccessibilityPanel(container);

  /**
   * What one tab's page scored. Extraction and the grade are local and free, so this is rebuilt
   * whenever the page changes, and whether the page carries rewrites is read off it at the same
   * time rather than remembered. Entries are evicted by tab-state when their tab navigates or closes.
   */
  interface TabAnalysis {
    pageModel: PageModel;
    /** Flesch-Kincaid grade, or null when the page holds no prose to score. */
    grade: number | null;
    /** What the page scored before a rewrite; meaningful only while one is in flight or applied. */
    originalGrade?: number;
    /** Whether the page currently carries rewrites — what "Restore original" hangs off. */
    rewritten: boolean;
    /** A rewrite is streaming into this tab; its controls stay locked until it finishes. */
    rewriting: boolean;
    status: string;
    /**
     * The paragraphs the reader pointed at, in the order they were picked. Re-resolved against the
     * page on every read, so a target that has scrolled out of the DOM is dropped rather than
     * silently aimed at whatever inherited its id.
     */
    targets: PickTarget[];
    /** What Rewrite acts on. "selected" is only honoured while `targets` is non-empty. */
    scope: "page" | "selected";
    /** The targeted paragraphs read as one passage, and what they scored before their rewrite. */
    targetGrade: number | null;
    targetOriginalGrade?: number;
  }

  const analyses = createTabStore<TabAnalysis>();
  /** Discards a read of a page the reader has already left behind. */
  let analyzeRun = 0;
  /**
   * How to stop each tab's rewrite. A run belongs to the tab it was started for, so switching away
   * never stops it — only Stop, a navigation, or the run finishing does.
   */
  const cancels = new Map<number, () => void>();
  /** The tab this panel's crosshair is armed on, if any. */
  let pickTabId: number | null = null;
  /** The tab whose HT_SELECTION reports drive "Use selection", and its last report. */
  let selectionTabId: number | null = null;
  let hasSelection = false;

  /**
   * Whether `tabId` is the tab in front of the reader. A null answer from tab-state means it hasn't
   * resolved the starting tab yet — nothing has moved, so the tab we looked up is still the one.
   */
  function isCurrentTab(tabId: number): boolean {
    const current = getCurrentTabId();
    return current === null || current === tabId;
  }

  /** The live text of every paragraph a target set still points at, in the order they were picked. */
  function targetBlocks(targets: readonly PickTarget[], blocks: readonly Block[]): Block[] {
    return targets.map((t) => blocks.find((b) => b.id === t.blockId)).filter((b): b is Block => b !== undefined);
  }

  /**
   * Reads and scores the page as it is now, re-resolving `targets` against what it found; null when
   * the page has no paragraph text at all. Whether a target carries a rewrite is read off the page
   * rather than remembered, which is what lets a rewritten paragraph — whose text no longer matches
   * the anchor it was targeted by — still be recognised.
   */
  async function readPage(
    tabId: number,
    targets: readonly PickTarget[],
  ): Promise<Pick<TabAnalysis, "pageModel" | "grade" | "rewritten" | "targets" | "targetGrade"> | null> {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPageBlocks });
    if (!result || result.blocks.length === 0) return null;

    const resolved = resolveTargets(targets, result.blocks, result.rewrittenIds);
    const selected = targetBlocks(resolved, result.blocks);

    return {
      pageModel: result,
      grade: computeFleschKincaidGrade(result.blocks.map((b) => b.text).join(" ")),
      rewritten: result.rewrittenIds.length > 0,
      targets: resolved,
      // The set is graded as one passage: it is what a single Rewrite will act on.
      targetGrade: selected.length ? computeFleschKincaidGrade(selected.map((b) => b.text).join(" ")) : null,
    };
  }

  /**
   * Which scope is actually in force. "selected" with nothing selected is a scope the panel cannot
   * honour, so it is never reported — the control and the button always agree with what Rewrite
   * will really do.
   */
  function effectiveScope(analysis: TabAnalysis | undefined): "page" | "selected" {
    return analysis && analysis.scope === "selected" && analysis.targets.length > 0 ? "selected" : "page";
  }

  /** How many paragraphs the next Rewrite would send, under the scope actually in force. */
  function rewriteCount(analysis: TabAnalysis | undefined): number {
    if (!analysis) return 0;
    return effectiveScope(analysis) === "selected" ? analysis.targets.length : analysis.pageModel.blocks.length;
  }

  /** Puts `tabId`'s analysis on screen, or the empty state if it has none. */
  function render(tabId: number | null): void {
    const analysis = analyses.get(tabId);
    const rewriting = analysis?.rewriting ?? false;
    const targets = analysis?.targets ?? [];
    const scope = effectiveScope(analysis);
    const selected = scope === "selected";

    // The headline is about whatever Rewrite would act on, so it moves with the scope.
    const headline = selected ? (analysis?.targetGrade ?? null) : (analysis?.grade ?? null);
    els.gradeNumber.textContent = headline == null ? "—" : String(headline);
    els.gradeLabel.textContent = selected
      ? `Reading grade · ${plural(targets.length, "selected paragraph")}`
      : "Reading grade";
    els.pageGradeNote.hidden = !selected || analysis?.grade == null;
    if (selected && analysis?.grade != null) els.pageGradeNote.textContent = `page reads at ${analysis.grade}`;

    const before = selected ? analysis?.targetOriginalGrade : analysis?.originalGrade;
    const wasRewritten = selected ? targets.some((t) => t.rewritten) : (analysis?.rewritten ?? false);
    const moved = wasRewritten && headline !== null && before !== undefined && before !== headline;
    els.gradeChange.hidden = !moved;
    if (moved) els.gradeChange.textContent = `was ${before} before the rewrite`;

    els.targetsSection.hidden = targets.length === 0;
    els.targetsLabel.textContent = `Target paragraphs · ${targets.length}`;
    els.clearTargetsBtn.disabled = rewriting;
    renderTargetList(tabId, targets, rewriting);

    // The counts sit on the scope control itself, so the cost of "Whole page" is legible before
    // it is chosen rather than only once the button relabels.
    els.pageScopeBtn.textContent = analysis ? `Whole page (${analysis.pageModel.blocks.length})` : "Whole page";
    els.selectedScopeBtn.textContent = targets.length ? `Selected (${targets.length})` : "Selected";
    els.pageScopeBtn.className = selected ? SCOPE_OFF : SCOPE_ON;
    els.selectedScopeBtn.className = selected ? SCOPE_ON : SCOPE_OFF;
    els.pageScopeBtn.disabled = !analysis || rewriting;
    els.selectedScopeBtn.disabled = !analysis || rewriting || targets.length === 0;
    els.selectedScopeBtn.title = targets.length === 0 ? "Pick a paragraph on the page first." : "";

    els.pickBtn.disabled = !analysis || rewriting;
    els.pickBtn.title = rewriting ? "Wait for the rewrite to finish." : "";
    els.selectionBtn.disabled = !analysis || rewriting || !hasSelection;
    els.selectionBtn.title = rewriting ? "Wait for the rewrite to finish." : hasSelection ? "" : NO_SELECTION_HINT;

    els.gradeSlider.disabled = !analysis || rewriting;
    els.bulletsCheckbox.disabled = !analysis || rewriting;
    // While a rewrite streams, the button it started from is the way to stop it.
    const count = rewriteCount(analysis);
    els.rewriteBtn.textContent = rewriting ? "Stop" : count ? rewriteButtonLabel(count) : "Rewrite";
    els.restoreBtn.hidden = !analysis?.rewritten;
    // Restoring under a stream would only be undone by the next patch to land.
    els.restoreBtn.disabled = rewriting;
    els.restoreBtn.title = rewriting ? "Wait for the rewrite to finish." : "";
    els.status.textContent = analysis?.status ?? "";
    void refreshRewriteButton(tabId);
  }

  /** One removable row per targeted paragraph, in the order they were picked. */
  function renderTargetList(tabId: number | null, targets: readonly PickTarget[], rewriting: boolean): void {
    els.targetList.replaceChildren();
    targets.forEach((target, index) => {
      const row = el("div", "flex items-start gap-2 rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5");
      const body = el("div", "flex gap-2 min-w-0");
      body.append(
        el("span", "shrink-0 text-xs text-muted tabular-nums", String(index + 1)),
        el("p", "text-xs text-neutral-300 leading-snug break-words", targetPreview(target.text)),
      );
      const remove = el("button", "shrink-0 text-xs text-muted hover:text-neutral-200 disabled:opacity-40", "✕");
      remove.title = "Stop targeting this paragraph";
      remove.setAttribute("aria-label", `Remove target paragraph ${index + 1}`);
      remove.disabled = rewriting;
      remove.addEventListener("click", () => {
        if (tabId === null) return;
        toggleTarget(tabId, target.blockId, target.text);
      });
      row.append(body, remove);
      els.targetList.appendChild(row);
    });
  }

  async function refreshRewriteButton(tabId: number | null): Promise<void> {
    const keyPresent = await hasApiKey();
    if (tabId === null || !isCurrentTab(tabId)) return;
    const analysis = analyses.get(tabId);
    // While a rewrite streams this button is Stop, and a Stop you cannot press is not a brake.
    if (analysis?.rewriting) {
      els.rewriteBtn.disabled = false;
      els.rewriteBtn.title = "Stop this rewrite; whatever has landed stays on the page.";
      return;
    }
    els.rewriteBtn.disabled = !analysis || !keyPresent;
    els.rewriteBtn.title = keyPresent ? "" : "Set an API key first.";
  }

  /** Stores a tab's analysis and re-renders if that tab is the one on screen. */
  function commit(tabId: number, analysis: TabAnalysis): void {
    // "was N before the rewrite" only means something while a rewrite is in flight or on the page.
    if (!analysis.rewriting && !analysis.rewritten) analysis.originalGrade = undefined;
    if (!analysis.rewriting && !analysis.rewritten) analysis.targetOriginalGrade = undefined;
    analyses.set(tabId, analysis);
    if (isCurrentTab(tabId)) render(tabId);
  }

  /** Records a change against a tab's analysis; a tab with none has navigated or closed. */
  function update(tabId: number, changes: Partial<TabAnalysis>): void {
    const analysis = analyses.get(tabId);
    if (analysis) commit(tabId, Object.assign(analysis, changes));
  }

  /**
   * Reads the page and scores it. Local and free — no network, no API key, no spend — which is why
   * this may run on its own when the reader switches to a tab nothing is stored for.
   */
  async function analyze(tabId: number): Promise<void> {
    const myRun = ++analyzeRun;
    if (isCurrentTab(tabId)) els.status.textContent = "Reading this page…";
    try {
      const previousTargets = analyses.get(tabId)?.targets ?? [];
      const page = await readPage(tabId, previousTargets);
      if (myRun !== analyzeRun) return;
      const previous = analyses.get(tabId);
      if (!page) {
        if (!previous?.rewriting) analyses.forget(tabId);
        if (isCurrentTab(tabId)) {
          render(tabId);
          els.status.textContent = "No paragraph text found on this page.";
        }
        return;
      }
      // A re-read under a streaming rewrite keeps saying so: the lock and its status are the
      // stream's to release, and whatever it reports at the end still belongs to this tab.
      const count = plural(page.pageModel.blocks.length, "paragraph");
      // Targets that were there and are not any more have to be said out loud: silently widening a
      // rewrite from a few paragraphs back to the whole page is the reader's money, not ours.
      const lost = previousTargets.length - page.targets.length;
      // A scope of "selected" that has lost its last target is not one the panel can honour.
      const scope = page.targets.length ? (previous?.scope ?? "selected") : "page";
      if (lost > 0 || page.targets.length > 0) syncTargetMarks(tabId, page.targets);
      commit(tabId, {
        ...page,
        scope,
        originalGrade: previous?.originalGrade,
        targetOriginalGrade: previous?.targetOriginalGrade,
        rewriting: previous?.rewriting ?? false,
        status: previous?.rewriting
          ? previous.status
          : lost > 0
            ? `${count} read. ${plural(lost, "targeted paragraph")} no longer on the page${page.targets.length ? "" : " — Rewrite is back to the whole page"}.`
            : page.grade === null
              ? `${count} read. No readable prose to grade.`
              : `${count} read.`,
      });
    } catch (err) {
      if (myRun === analyzeRun && isCurrentTab(tabId)) els.status.textContent = pageAccessError(err);
    }
  }

  /**
   * Rescores the page after something changed it, leaving status and the rewrite lock alone.
   * Rewrites replace a paragraph's contents without adding or removing a `p`, so re-extracting
   * stamps the same block ids back onto the same elements and a later Rewrite still lands.
   */
  async function regrade(tabId: number): Promise<void> {
    try {
      const page = await readPage(tabId, analyses.get(tabId)?.targets ?? []);
      if (page) update(tabId, page);
    } catch {
      // The grade is a readout, not a result. A page that cannot be re-read keeps the number it had.
    }
  }

  /**
   * Says something to the reader. Status normally lives on the tab's analysis so it survives a
   * switch away and back, but the things that go wrong on the way to one — an unscriptable page,
   * no tab yet — have no analysis to hang off and still have to be said.
   */
  function say(tabId: number | null, status: string): void {
    if (tabId !== null && analyses.get(tabId)) update(tabId, { status });
    else if (tabId === null || isCurrentTab(tabId)) els.status.textContent = status;
  }

  /** Stops a tab's rewrite where it stands, leaving whatever already landed on the page. */
  function stopRewrite(tabId: number): void {
    const cancel = cancels.get(tabId);
    if (!cancel) return;
    cancels.delete(tabId);
    cancel();
  }

  /** Draws the current target set on the page itself; an empty set clears the marks. */
  function syncTargetMarks(tabId: number, targets: readonly PickTarget[]): void {
    void chrome.scripting
      .executeScript({ target: { tabId }, func: markTargets, args: [targets.map((t) => t.blockId)] })
      .catch(() => {
        // The page went away or can't be scripted; the marks went with it either way.
      });
  }

  /**
   * Replaces a tab's target set. Picking something switches the scope to Selected, because that is
   * plainly what the gesture meant; losing the last target switches it back, because "selected" is
   * not a scope the panel can honour with nothing selected.
   */
  function setTargets(tabId: number, targets: PickTarget[], status: string): void {
    const analysis = analyses.get(tabId);
    if (!analysis) return;
    // Which paragraphs carry a rewrite is the page's answer, last read into the current set. Drop it
    // here and a rewritten target — whose text no longer matches the anchor it was picked by — would
    // fail to re-resolve and quietly fall out of the set on the next click.
    const rewrittenIds = analysis.targets.filter((t) => t.rewritten).map((t) => t.blockId);
    const resolved = resolveTargets(targets, analysis.pageModel.blocks, rewrittenIds);
    const selected = targetBlocks(resolved, analysis.pageModel.blocks);
    syncTargetMarks(tabId, resolved);
    commit(
      tabId,
      Object.assign(analysis, {
        targets: resolved,
        scope: resolved.length ? ("selected" as const) : ("page" as const),
        targetGrade: selected.length ? computeFleschKincaidGrade(selected.map((b) => b.text).join(" ")) : null,
        targetOriginalGrade: undefined,
        status,
      }),
    );
  }

  /** Adds a paragraph to the set, or takes it out if it is already in — one click does both. */
  function toggleTarget(tabId: number, blockId: string, text: string): void {
    const analysis = analyses.get(tabId);
    if (!analysis || analysis.rewriting) return;
    const existing = analysis.targets.filter((t) => t.blockId !== blockId);
    if (existing.length !== analysis.targets.length) {
      setTargets(
        tabId,
        existing,
        existing.length ? `${plural(existing.length, "paragraph")} targeted.` : "Nothing targeted — Rewrite is back to the whole page.",
      );
      return;
    }
    const next = [...analysis.targets, { blockId, text }];
    setTargets(tabId, next, `${plural(next.length, "paragraph")} targeted.`);
  }

  function setPicking(tabId: number | null): void {
    pickTabId = tabId;
    els.pickLabel.textContent = tabId === null ? "Pick paragraph" : "Cancel picking";
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
      say(getCurrentTabId(), "Picking cancelled.");
      return;
    }
    try {
      const tabId = await getActiveTabId();
      // Only stamped paragraphs light up, and the stamps are from the last read — so re-read first,
      // or a page that has changed since would offer a crosshair over the wrong paragraphs.
      await analyze(tabId);
      if (!analyses.get(tabId)) return;
      await chrome.scripting.executeScript({
        target: { tabId },
        func: startPickMode,
        args: [{ source: PICK_SOURCE, selector: PICK_SELECTOR, underlineClaims: false, multi: true }],
      });
      setPicking(tabId);
      say(tabId, PICK_HINT);
    } catch (err) {
      say(getCurrentTabId(), pageAccessError(err));
    }
  }

  /** Targets the paragraph containing whatever the reader has selected on the page. */
  async function targetSelection(): Promise<void> {
    try {
      const tabId = await getActiveTabId();
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: captureSelectedBlock });
      if (!isCurrentTab(tabId)) return;
      if (!result) {
        say(tabId, "That selection isn't inside a paragraph this panel can rewrite.");
        return;
      }
      toggleTarget(tabId, result.blockId, result.text);
    } catch (err) {
      say(getCurrentTabId(), pageAccessError(err));
    }
  }

  /**
   * Starts listening to a tab's selection; the watcher reports straight back via HT_SELECTION and
   * again whenever it changes. Re-run on every switch and load: an injected script does not survive
   * a navigation, and only the tab in front of the reader drives the button.
   */
  async function watchSelectionOn(tabId: number): Promise<void> {
    hasSelection = false;
    selectionTabId = tabId;
    render(getCurrentTabId());
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: watchSelection });
    } catch {
      // Pages the extension can't script never have a selection to target.
    }
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return;
    const fromTab = sender.tab.id;
    if (message?.type === "HT_SELECTION" && fromTab === selectionTabId) {
      hasSelection = message.hasSelection === true;
      render(getCurrentTabId());
      return;
    }
    // The Inspector's crosshair, armed over the same page. Not ours to act on.
    if (message?.source !== PICK_SOURCE) return;
    if (message.type === "HT_PICKED" && fromTab === pickTabId) {
      if (typeof message.blockId !== "string") {
        say(fromTab, "That paragraph isn't one this panel can rewrite.");
        return;
      }
      // The crosshair stays armed for the next click, so the panel does not stop picking here.
      toggleTarget(fromTab, message.blockId, String(message.text ?? ""));
    } else if (message.type === "HT_PICK_CANCELLED" && fromTab === pickTabId) {
      setPicking(null);
      say(fromTab, "Picking cancelled.");
    }
  });

  els.pickBtn.addEventListener("click", () => void togglePick());
  els.selectionBtn.addEventListener("click", () => void targetSelection());
  els.clearTargetsBtn.addEventListener("click", () => {
    const tabId = getCurrentTabId();
    if (tabId === null || analyses.get(tabId)?.rewriting) return;
    setTargets(tabId, [], "Nothing targeted — Rewrite is back to the whole page.");
  });

  /** Switching scope is free and reversible, so it says what it now means rather than warning. */
  function setScope(scope: "page" | "selected"): void {
    const tabId = getCurrentTabId();
    const analysis = analyses.get(tabId);
    if (tabId === null || !analysis || analysis.rewriting) return;
    if (scope === "selected" && analysis.targets.length === 0) return;
    const count = scope === "selected" ? analysis.targets.length : analysis.pageModel.blocks.length;
    commit(tabId, Object.assign(analysis, { scope, status: `Rewrite will act on ${plural(count, "paragraph")}.` }));
  }

  els.pageScopeBtn.addEventListener("click", () => setScope("page"));
  els.selectedScopeBtn.addEventListener("click", () => setScope("selected"));

  els.optionsLink.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  els.gradeSlider.addEventListener("input", () => {
    els.gradeValue.textContent = els.gradeSlider.value;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    const relevant = "openaiApiKey" in changes || "openrouterApiKey" in changes || "provider" in changes;
    if (area !== "local" || !relevant) return;
    void refreshRewriteButton(getCurrentTabId());
  });

  els.rewriteBtn.addEventListener("click", async () => {
    const tabId = getCurrentTabId();
    const analysis = analyses.get(tabId);
    if (tabId === null || !analysis) return;
    // While a rewrite streams, this button is Stop.
    if (analysis.rewriting) {
      stopRewrite(tabId);
      return;
    }

    const grade = Number(els.gradeSlider.value) as Grade;
    const format: RewriteFormat = els.bulletsCheckbox.checked ? "bullets" : "prose";

    // Patches are keyed by ids stamped when the page was read, so they only mean anything on that
    // tab. Holding analyses per tab keeps these in step by construction; this still catches the
    // tab moving out from under the click while the check itself is in flight.
    if (!(await isActiveTab(tabId))) {
      els.status.textContent = TAB_MOVED;
      return;
    }

    // Targets are resolved against the page as it was last read rather than trusted from when they
    // were picked, so a rewrite never lands on a paragraph that has since moved.
    const selected = effectiveScope(analysis) === "selected";
    const blocks: Block[] = selected
      ? targetBlocks(analysis.targets, analysis.pageModel.blocks)
      : analysis.pageModel.blocks;
    if (selected && blocks.length === 0) {
      update(tabId, { status: "The paragraphs you targeted are no longer on the page." });
      void analyze(tabId);
      return;
    }

    const total = blocks.length;
    // Only a single targeted paragraph is named rather than counted; a set of them reads as a count.
    const targeted = selected && total === 1;
    let failed = 0;
    let landed = 0;
    let lastError: string | null = null;
    /** Patches still landing on the page; the final grade waits for the last of them. */
    const landing: Promise<unknown>[] = [];
    update(tabId, {
      rewriting: true,
      originalGrade: analysis.grade ?? undefined,
      targetOriginalGrade: analysis.targetGrade ?? undefined,
      status: rewriteProgress(0, total, 0, null, targeted),
    });

    const cancel = startRewrite(blocks, grade, format, {
      onProgress: (msg) => {
        // Patches keep landing on the tab they were computed for even if the reader has moved on:
        // they belong to that page, and the spend already happened.
        landed += 1;
        landing.push(
          chrome.scripting.executeScript({ target: { tabId }, func: applyRewrites, args: [[msg.patch]] }).catch(() => {}),
        );
        update(tabId, { rewritten: true, status: rewriteProgress(msg.done, msg.total, failed, lastError, targeted) });
      },
      onParagraphError: (msg) => {
        failed += 1;
        lastError = msg.message;
        update(tabId, { status: rewriteProgress(msg.done, msg.total, failed, lastError, targeted) });
      },
      onDone: (msg) => {
        cancels.delete(tabId);
        // The page says something different now, so the number describing it is recomputed.
        void Promise.allSettled(landing).then(() => regrade(tabId));
        update(tabId, { rewriting: false, status: rewriteSummary(msg.succeeded, msg.failed, grade, lastError, targeted) });
      },
      onFatalError: (msg) => {
        cancels.delete(tabId);
        // Whatever landed before the failure is still on the page and still counts.
        void Promise.allSettled(landing).then(() => regrade(tabId));
        update(tabId, { rewriting: false, status: msg.message });
      },
      onDisconnect: () => {
        cancels.delete(tabId);
        void Promise.allSettled(landing).then(() => regrade(tabId));
        update(tabId, {
          rewriting: false,
          status: "Lost the connection to the extension mid-rewrite. Whatever was rewritten is still on the page.",
        });
      },
    });

    // Chrome never reports a port this side closed (see messages.ts), so Stop has to write its own
    // outcome. It reads the counters this run keeps rather than waiting to be told.
    cancels.set(tabId, () => {
      cancel();
      void Promise.allSettled(landing).then(() => regrade(tabId));
      update(tabId, { rewriting: false, status: rewriteStopped(landed, total) });
    });
  });

  els.restoreBtn.addEventListener("click", async () => {
    const tabId = getCurrentTabId();
    const analysis = analyses.get(tabId);
    if (tabId === null || !analysis || analysis.rewriting) return;
    if (!(await isActiveTab(tabId))) {
      els.status.textContent = TAB_MOVED;
      return;
    }
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: restoreOriginal });
      const restored = result ?? 0;
      update(tabId, {
        rewritten: false,
        status:
          restored > 0
            ? `Original text restored in ${plural(restored, "paragraph")}.`
            : "Nothing to restore — the page has changed since it was rewritten.",
      });
      void regrade(tabId);
    } catch (err) {
      update(tabId, { status: pageAccessError(err) });
    }
  });

  onTabActivated((tabId) => {
    // Picking is a gesture on the page in front of you; it doesn't follow the reader to another.
    if (pickTabId !== null && pickTabId !== tabId) void stopPicking();
    render(tabId);
    void watchSelectionOn(tabId);
    // Reading is free, so a tab with nothing stored gets read. Rewriting is not, so it never
    // starts on its own — switching tabs is navigation, not consent to spend.
    if (!analyses.get(tabId)) whenVisible(container, () => void analyze(tabId));
  });

  onTabNavigated((tabId) => {
    // tab-state has already dropped this tab's analysis, and with it the targets: their block ids
    // belong to a page that left. The crosshair and any rewrite went with the old document too —
    // its remaining patches would land on ids that now mean something else, or nothing.
    stopRewrite(tabId);
    if (pickTabId === tabId) void stopPicking();
    render(tabId);
    // The URL changes as the navigation commits, before the new document has any text, so reading
    // now would grade an empty page. onTabLoaded takes it from here unless the load already finished.
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") whenVisible(container, () => void analyze(tabId));
        else if (isCurrentTab(tabId)) els.status.textContent = "Reading this page…";
      })
      .catch(() => {
        // The tab closed before it could be asked.
      });
  });

  onTabLoaded((tabId) => {
    // A fresh document: whatever was stamped or rewritten on the old one went with it. Only the
    // rewrite lock survives — its port is still open and what it reports still belongs here.
    const previous = analyses.get(tabId);
    if (previous && !previous.rewriting) analyses.forget(tabId);
    if (pickTabId === tabId) void stopPicking();
    render(tabId);
    void watchSelectionOn(tabId);
    whenVisible(container, () => void analyze(tabId));
  });

  // Tab events only fire once something moves, so the tab the panel opened over would otherwise sit
  // at an empty readout until the reader switched away and back. Score it as soon as it is on screen.
  whenVisible(container, () => {
    void (async () => {
      try {
        const tabId = getCurrentTabId() ?? (await getActiveTabId());
        void watchSelectionOn(tabId);
        if (!analyses.get(tabId)) await analyze(tabId);
      } catch {
        // No tab to attach to yet; the first tab event will bring one.
      }
    })();
  });
}
