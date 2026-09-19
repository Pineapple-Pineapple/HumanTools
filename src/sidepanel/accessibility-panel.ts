import { computeFleschKincaidGrade } from "../lib/flesch-kincaid";
import { extractPageBlocks, applyRewrites, applyBullets, restoreOriginal } from "../content/functions";
import { startRewrite } from "../lib/messages";
import { getActiveTabId, isActiveTab } from "../lib/active-tab";
import { createTabStore, getCurrentTabId, onTabActivated, onTabNavigated } from "../lib/tab-state";
import { whenVisible } from "../lib/panel-visibility";
import { hasApiKey } from "../lib/provider";
import type { Grade, PageModel, RewriteFormat } from "../lib/types";

const GRADE_STEPS: Grade[] = [6, 8, 10, 12];
const DEFAULT_GRADE: Grade = 8;

/** Turns scripting failures on pages extensions can't touch into something a reader understands. */
function pageAccessError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\//i.test(message)) {
    return "This page can't be analyzed — browser pages and extension stores are off-limits to extensions.";
  }
  return message || "Analysis failed.";
}

interface AccessibilityPanelEls {
  root: HTMLElement;
  analyzeBtn: HTMLButtonElement;
  gradeReadout: HTMLElement;
  gradeSlider: HTMLInputElement;
  gradeValue: HTMLElement;
  bulletsCheckbox: HTMLInputElement;
  rewriteBtn: HTMLButtonElement;
  restoreBtn: HTMLButtonElement;
  status: HTMLElement;
  optionsLink: HTMLButtonElement;
}

function renderAccessibilityPanel(container: HTMLElement): AccessibilityPanelEls {
  const root = document.createElement("div");
  root.className = "p-4 flex flex-col gap-4 text-sm";

  const heading = document.createElement("h1");
  heading.textContent = "Accessibility — make this understandable";
  heading.className = "text-neutral-100 font-medium";

  const analyzeGroup = document.createElement("div");
  analyzeGroup.className = "flex flex-col gap-2";

  const analyzeBtn = document.createElement("button");
  analyzeBtn.textContent = "Analyze this page";
  analyzeBtn.className =
    "self-start px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 border border-neutral-600 rounded text-neutral-100";

  const gradeReadout = document.createElement("p");
  gradeReadout.className = "text-neutral-400";
  gradeReadout.textContent = "Reading grade: —";

  analyzeGroup.append(analyzeBtn, gradeReadout);

  const rewriteGroup = document.createElement("div");
  rewriteGroup.className = "flex flex-col gap-3 pt-3 border-t border-neutral-800";

  const gradeRow = document.createElement("div");
  gradeRow.className = "flex flex-col gap-1";

  const gradeLabelRow = document.createElement("div");
  gradeLabelRow.className = "flex items-center justify-between text-neutral-300";
  const gradeLabel = document.createElement("span");
  gradeLabel.textContent = "Rewrite for grade";
  const gradeValue = document.createElement("span");
  gradeValue.className = "text-neutral-100 font-medium";
  gradeValue.textContent = String(DEFAULT_GRADE);
  gradeLabelRow.append(gradeLabel, gradeValue);

  const gradeSlider = document.createElement("input");
  gradeSlider.type = "range";
  gradeSlider.min = "6";
  gradeSlider.max = "12";
  gradeSlider.step = "2";
  gradeSlider.value = String(DEFAULT_GRADE);
  gradeSlider.disabled = true;
  gradeSlider.className = "w-full accent-amber-600";

  const ticksRow = document.createElement("div");
  ticksRow.className = "flex justify-between text-xs text-neutral-500 px-0.5";
  for (const grade of GRADE_STEPS) {
    const tick = document.createElement("span");
    tick.textContent = String(grade);
    ticksRow.appendChild(tick);
  }

  gradeRow.append(gradeLabelRow, gradeSlider, ticksRow);

  const bulletsRow = document.createElement("label");
  bulletsRow.className = "flex items-center gap-2 text-neutral-300";
  const bulletsCheckbox = document.createElement("input");
  bulletsCheckbox.type = "checkbox";
  bulletsCheckbox.disabled = true;
  const bulletsLabel = document.createElement("span");
  bulletsLabel.textContent = "Convert to bullet points";
  bulletsRow.append(bulletsCheckbox, bulletsLabel);

  const actionRow = document.createElement("div");
  actionRow.className = "flex gap-2";
  const rewriteBtn = document.createElement("button");
  rewriteBtn.textContent = "Rewrite";
  rewriteBtn.disabled = true;
  rewriteBtn.className =
    "px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:hover:bg-amber-600 rounded text-neutral-950 font-medium";

  const restoreBtn = document.createElement("button");
  restoreBtn.textContent = "Restore original";
  restoreBtn.hidden = true;
  restoreBtn.className =
    "px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 border border-neutral-600 rounded text-neutral-100";
  actionRow.append(rewriteBtn, restoreBtn);

  const status = document.createElement("p");
  status.className = "text-xs text-neutral-500 min-h-[1em]";

  const optionsLink = document.createElement("button");
  optionsLink.textContent = "Set API key";
  optionsLink.className = "self-start text-xs text-amber-500 hover:underline";

  rewriteGroup.append(gradeRow, bulletsRow, actionRow, status, optionsLink);
  root.append(heading, analyzeGroup, rewriteGroup);
  container.appendChild(root);

  return {
    root,
    analyzeBtn,
    gradeReadout,
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
   * What Analyze found on one tab. Extraction and the grade are local and free, so this can be
   * rebuilt on demand; whether the page currently carries rewrites cannot, so it is recorded here.
   * Entries are evicted by tab-state when their tab navigates or closes.
   */
  interface TabAnalysis {
    pageModel: PageModel;
    grade: number;
    /** Whether this tab's page has rewrites applied — what "Restore original" hangs off. */
    rewritten: boolean;
    /** A rewrite is streaming into this tab; its controls stay locked until it finishes. */
    rewriting: boolean;
    status: string;
  }

  const analyses = createTabStore<TabAnalysis>();
  /** Discards an analysis whose tab the reader has already left behind. */
  let analyzeRun = 0;

  /**
   * Whether `tabId` is the tab in front of the reader. A null answer from tab-state means it hasn't
   * resolved the starting tab yet — nothing has moved, so the tab we looked up is still the one.
   */
  function isCurrentTab(tabId: number): boolean {
    const current = getCurrentTabId();
    return current === null || current === tabId;
  }

  /** Puts `tabId`'s analysis on screen, or the empty state if it has none. */
  function render(tabId: number | null): void {
    const analysis = analyses.get(tabId);
    if (!analysis) {
      els.gradeReadout.textContent = "Reading grade: —";
      els.gradeSlider.disabled = true;
      els.bulletsCheckbox.disabled = true;
      els.rewriteBtn.disabled = true;
      els.restoreBtn.hidden = true;
      els.status.textContent = "";
      return;
    }
    els.gradeReadout.textContent = `Reading grade: ${analysis.grade}`;
    els.gradeSlider.disabled = analysis.rewriting;
    els.bulletsCheckbox.disabled = analysis.rewriting;
    els.restoreBtn.hidden = !analysis.rewritten;
    els.status.textContent = analysis.status;
    void refreshRewriteButton(tabId);
  }

  async function refreshRewriteButton(tabId: number | null): Promise<void> {
    const keyPresent = await hasApiKey();
    if (tabId === null || !isCurrentTab(tabId)) return;
    const analysis = analyses.get(tabId);
    els.rewriteBtn.disabled = !analysis || analysis.rewriting || !keyPresent;
    els.rewriteBtn.title = keyPresent ? "" : "Set an API key first.";
  }

  /** Records a change against a tab's analysis and re-renders only if that tab is the one on screen. */
  function update(tabId: number, changes: Partial<TabAnalysis>): void {
    const analysis = analyses.get(tabId);
    // Gone means the tab navigated or closed: the analysis described a page that no longer exists.
    if (!analysis) return;
    Object.assign(analysis, changes);
    if (isCurrentTab(tabId)) render(tabId);
  }

  /**
   * Reads the page and scores it. Local and free — no network, no API key, no spend — which is why
   * this may run on its own when the reader switches to a tab nothing is stored for.
   */
  async function analyze(tabId: number): Promise<void> {
    const myRun = ++analyzeRun;
    if (isCurrentTab(tabId)) {
      els.status.textContent = "Analyzing…";
      els.analyzeBtn.disabled = true;
    }
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPageBlocks });
      if (myRun !== analyzeRun) return;
      const pageModel = result ?? null;
      if (!pageModel || pageModel.blocks.length === 0) {
        if (isCurrentTab(tabId)) els.status.textContent = "No paragraph text found on this page.";
        return;
      }

      const grade = computeFleschKincaidGrade(pageModel.blocks.map((b) => b.text).join(" "));
      const keyPresent = await hasApiKey();
      if (myRun !== analyzeRun) return;

      // Re-analyzing re-reads the text; it does not undo anything already done to the page. A tab
      // that is mid-rewrite, or already carries one, keeps saying so.
      const previous = analyses.get(tabId);
      analyses.set(tabId, {
        pageModel,
        grade,
        rewritten: previous?.rewritten ?? false,
        rewriting: previous?.rewriting ?? false,
        status: previous?.rewriting
          ? previous.status
          : keyPresent
            ? `${pageModel.blocks.length} paragraphs analyzed.`
            : `${pageModel.blocks.length} paragraphs analyzed. Set an API key to rewrite.`,
      });
      if (isCurrentTab(tabId)) render(tabId);
    } catch (err) {
      if (myRun === analyzeRun && isCurrentTab(tabId)) els.status.textContent = pageAccessError(err);
    } finally {
      if (myRun === analyzeRun) els.analyzeBtn.disabled = false;
    }
  }

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

  els.analyzeBtn.addEventListener("click", async () => {
    try {
      await analyze(getCurrentTabId() ?? (await getActiveTabId()));
    } catch (err) {
      els.status.textContent = pageAccessError(err);
    }
  });

  els.rewriteBtn.addEventListener("click", async () => {
    const tabId = getCurrentTabId();
    const analysis = analyses.get(tabId);
    if (tabId === null || !analysis || analysis.pageModel.blocks.length === 0 || analysis.rewriting) return;

    const grade = Number(els.gradeSlider.value) as Grade;
    const format: RewriteFormat = els.bulletsCheckbox.checked ? "bullets" : "prose";

    // Patches are keyed by ids stamped during Analyze, so they only mean anything on that tab.
    // Holding analyses per tab keeps these in step by construction; this still catches the tab
    // moving out from under the click while the check itself is in flight.
    if (!(await isActiveTab(tabId))) {
      els.status.textContent = "This analysis belongs to another tab. Switch back to it, or analyze this page first.";
      return;
    }

    const total = analysis.pageModel.blocks.length;
    update(tabId, { rewriting: true, status: `Rewriting… 0/${total} paragraphs` });

    startRewrite(analysis.pageModel.blocks, grade, format, {
      onProgress: (msg) => {
        // Patches keep landing on the tab they were computed for even if the reader has moved on:
        // they belong to that page, and the spend already happened.
        if (format === "bullets" && msg.patch.bullets) {
          chrome.scripting.executeScript({
            target: { tabId },
            func: applyBullets,
            args: [[{ id: msg.patch.id, bullets: msg.patch.bullets }]],
          });
        } else if (msg.patch.text !== undefined) {
          chrome.scripting.executeScript({
            target: { tabId },
            func: applyRewrites,
            args: [[{ id: msg.patch.id, text: msg.patch.text }]],
          });
        }
        update(tabId, { rewritten: true, status: `Rewriting… ${msg.done}/${msg.total} paragraphs` });
      },
      onParagraphError: (msg) => {
        update(tabId, { status: `Rewriting… ${msg.done}/${msg.total} paragraphs` });
      },
      onDone: (msg) => {
        update(tabId, {
          rewriting: false,
          status:
            msg.failed > 0
              ? `Rewrote ${msg.succeeded}/${msg.succeeded + msg.failed} paragraphs at grade ${grade} (${msg.failed} failed). Hover a paragraph to see the original.`
              : `Rewrote ${msg.succeeded} paragraphs at grade ${grade}. Hover a paragraph to see the original.`,
        });
      },
      onFatalError: (msg) => {
        update(tabId, { rewriting: false, status: msg.message });
      },
    });
  });

  els.restoreBtn.addEventListener("click", async () => {
    const tabId = getCurrentTabId();
    if (tabId === null || !analyses.get(tabId)) return;
    if (!(await isActiveTab(tabId))) {
      els.status.textContent = "This analysis belongs to another tab. Switch back to it, or analyze this page first.";
      return;
    }
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: restoreOriginal });
      update(tabId, {
        rewritten: false,
        status: result
          ? `Original text restored in ${result} paragraph${result === 1 ? "" : "s"}.`
          : "Nothing to restore — the page has changed since it was rewritten.",
      });
    } catch (err) {
      update(tabId, { status: err instanceof Error ? err.message : "Restore failed." });
    }
  });

  onTabActivated((tabId) => {
    render(tabId);
    // Analysis is free, so a tab with nothing stored gets one. Rewriting is not, so it never
    // starts on its own — switching tabs is navigation, not consent to spend.
    if (!analyses.get(tabId)) whenVisible(container, () => void analyze(tabId));
  });

  onTabNavigated((tabId) => {
    // tab-state has already dropped this tab's analysis: its block ids belong to a page that left.
    render(tabId);
    whenVisible(container, () => void analyze(tabId));
  });
}
