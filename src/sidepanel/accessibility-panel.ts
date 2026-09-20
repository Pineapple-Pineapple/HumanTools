import { computeFleschKincaidGrade } from "../lib/flesch-kincaid";
import { applyRewrites, extractPageBlocks, restoreOriginal } from "../content/functions";
import { startRewrite } from "../lib/messages";
import { getActiveTabId, isActiveTab } from "../lib/active-tab";
import { createTabStore, getCurrentTabId, onTabActivated, onTabLoaded, onTabNavigated } from "../lib/tab-state";
import { whenVisible } from "../lib/panel-visibility";
import { hasApiKey } from "../lib/provider";
import { BTN, BTN_PRIMARY, H1, LINK_BTN, SECTION_LABEL, STATUS, el, pageAccessError } from "./ui";
import type { Grade, PageModel, RewriteFormat } from "../lib/types";

const GRADE_STEPS: Grade[] = [6, 8, 10, 12];
const DEFAULT_GRADE: Grade = 8;
const TAB_MOVED = "The tab in front of you changed — switch back and try again.";

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** A provider error as it reads inside a sentence: no trailing full stop of its own. */
function reason(lastError: string | null): string | null {
  const trimmed = lastError?.trim().replace(/\.$/, "");
  return trimmed || null;
}

/** The status line while paragraphs stream in. A failure says why, not just that it happened. */
export function rewriteProgress(done: number, total: number, failed: number, lastError: string | null): string {
  const base = `Rewriting… ${done}/${total} paragraphs`;
  if (failed === 0) return base;
  const why = reason(lastError);
  return `${base} (${failed} failed${why ? `: ${why}` : ""})`;
}

/** The status line once the rewrite is over. Only promises a hover when something was rewritten. */
export function rewriteSummary(succeeded: number, failed: number, grade: Grade, lastError: string | null): string {
  const total = succeeded + failed;
  const why = reason(lastError);
  const failure = why ? `: ${why}.` : ".";
  if (succeeded === 0) return `Couldn't rewrite any of the ${plural(total, "paragraph")}${failure}`;
  const outcome =
    failed === 0
      ? `Rewrote ${plural(succeeded, "paragraph")} at grade ${grade}.`
      : `Rewrote ${succeeded} of ${total} paragraphs at grade ${grade}; ${failed} failed${failure}`;
  return `${outcome} Hover a paragraph to see the original.`;
}

interface AccessibilityPanelEls {
  gradeNumber: HTMLElement;
  gradeChange: HTMLElement;
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
  const gradeChange = el("p", "text-xs text-amber-400");
  gradeChange.hidden = true;
  gradeGroup.append(gradeNumber, el("p", SECTION_LABEL, "Reading grade"), gradeChange);

  const rewriteGroup = el("div", "flex flex-col gap-3 pt-3 border-t border-neutral-800");

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

  rewriteGroup.append(gradeRow, bulletsRow, actionRow, status, optionsLink);
  root.append(heading, gradeGroup, rewriteGroup);
  container.appendChild(root);

  return { gradeNumber, gradeChange, gradeSlider, gradeValue, bulletsCheckbox, rewriteBtn, restoreBtn, status, optionsLink };
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
  }

  const analyses = createTabStore<TabAnalysis>();
  /** Discards a read of a page the reader has already left behind. */
  let analyzeRun = 0;

  /**
   * Whether `tabId` is the tab in front of the reader. A null answer from tab-state means it hasn't
   * resolved the starting tab yet — nothing has moved, so the tab we looked up is still the one.
   */
  function isCurrentTab(tabId: number): boolean {
    const current = getCurrentTabId();
    return current === null || current === tabId;
  }

  /** Reads and scores the page as it is now; null when it has no paragraph text at all. */
  async function readPage(tabId: number): Promise<Pick<TabAnalysis, "pageModel" | "grade" | "rewritten"> | null> {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPageBlocks });
    if (!result || result.blocks.length === 0) return null;
    return {
      pageModel: result,
      grade: computeFleschKincaidGrade(result.blocks.map((b) => b.text).join(" ")),
      rewritten: result.rewrittenBlocks > 0,
    };
  }

  /** Puts `tabId`'s analysis on screen, or the empty state if it has none. */
  function render(tabId: number | null): void {
    const analysis = analyses.get(tabId);
    const rewriting = analysis?.rewriting ?? false;
    els.gradeNumber.textContent = analysis?.grade == null ? "—" : String(analysis.grade);
    const moved =
      analysis !== undefined &&
      analysis.rewritten &&
      analysis.grade !== null &&
      analysis.originalGrade !== undefined &&
      analysis.originalGrade !== analysis.grade;
    els.gradeChange.hidden = !moved;
    if (moved) els.gradeChange.textContent = `was ${analysis.originalGrade} before the rewrite`;
    els.gradeSlider.disabled = !analysis || rewriting;
    els.bulletsCheckbox.disabled = !analysis || rewriting;
    els.restoreBtn.hidden = !analysis?.rewritten;
    // Restoring under a stream would only be undone by the next patch to land.
    els.restoreBtn.disabled = rewriting;
    els.restoreBtn.title = rewriting ? "Wait for the rewrite to finish." : "";
    els.status.textContent = analysis?.status ?? "";
    void refreshRewriteButton(tabId);
  }

  async function refreshRewriteButton(tabId: number | null): Promise<void> {
    const keyPresent = await hasApiKey();
    if (tabId === null || !isCurrentTab(tabId)) return;
    const analysis = analyses.get(tabId);
    els.rewriteBtn.disabled = !analysis || analysis.rewriting || !keyPresent;
    els.rewriteBtn.title = keyPresent ? "" : "Set an API key first.";
  }

  /** Stores a tab's analysis and re-renders if that tab is the one on screen. */
  function commit(tabId: number, analysis: TabAnalysis): void {
    // "was N before the rewrite" only means something while a rewrite is in flight or on the page.
    if (!analysis.rewriting && !analysis.rewritten) analysis.originalGrade = undefined;
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
      const page = await readPage(tabId);
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
      commit(tabId, {
        ...page,
        originalGrade: previous?.originalGrade,
        rewriting: previous?.rewriting ?? false,
        status: previous?.rewriting
          ? previous.status
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
      const page = await readPage(tabId);
      if (page) update(tabId, page);
    } catch {
      // The grade is a readout, not a result. A page that cannot be re-read keeps the number it had.
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

  els.rewriteBtn.addEventListener("click", async () => {
    const tabId = getCurrentTabId();
    const analysis = analyses.get(tabId);
    if (tabId === null || !analysis || analysis.rewriting) return;

    const grade = Number(els.gradeSlider.value) as Grade;
    const format: RewriteFormat = els.bulletsCheckbox.checked ? "bullets" : "prose";

    // Patches are keyed by ids stamped when the page was read, so they only mean anything on that
    // tab. Holding analyses per tab keeps these in step by construction; this still catches the
    // tab moving out from under the click while the check itself is in flight.
    if (!(await isActiveTab(tabId))) {
      els.status.textContent = TAB_MOVED;
      return;
    }

    const total = analysis.pageModel.blocks.length;
    let failed = 0;
    let lastError: string | null = null;
    /** Patches still landing on the page; the final grade waits for the last of them. */
    const landing: Promise<unknown>[] = [];
    update(tabId, {
      rewriting: true,
      originalGrade: analysis.grade ?? undefined,
      status: rewriteProgress(0, total, 0, null),
    });

    startRewrite(analysis.pageModel.blocks, grade, format, {
      onProgress: (msg) => {
        // Patches keep landing on the tab they were computed for even if the reader has moved on:
        // they belong to that page, and the spend already happened.
        landing.push(
          chrome.scripting.executeScript({ target: { tabId }, func: applyRewrites, args: [[msg.patch]] }).catch(() => {}),
        );
        update(tabId, { rewritten: true, status: rewriteProgress(msg.done, msg.total, failed, lastError) });
      },
      onParagraphError: (msg) => {
        failed += 1;
        lastError = msg.message;
        update(tabId, { status: rewriteProgress(msg.done, msg.total, failed, lastError) });
      },
      onDone: (msg) => {
        // The page says something different now, so the number describing it is recomputed.
        void Promise.allSettled(landing).then(() => regrade(tabId));
        update(tabId, { rewriting: false, status: rewriteSummary(msg.succeeded, msg.failed, grade, lastError) });
      },
      onFatalError: (msg) => {
        // Whatever landed before the failure is still on the page and still counts.
        void Promise.allSettled(landing).then(() => regrade(tabId));
        update(tabId, { rewriting: false, status: msg.message });
      },
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
    render(tabId);
    // Reading is free, so a tab with nothing stored gets read. Rewriting is not, so it never
    // starts on its own — switching tabs is navigation, not consent to spend.
    if (!analyses.get(tabId)) whenVisible(container, () => void analyze(tabId));
  });

  onTabNavigated((tabId) => {
    // tab-state has already dropped this tab's analysis: its block ids belong to a page that left.
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
    render(tabId);
    whenVisible(container, () => void analyze(tabId));
  });

  // Tab events only fire once something moves, so the tab the panel opened over would otherwise sit
  // at an empty readout until the reader switched away and back. Score it as soon as it is on screen.
  whenVisible(container, () => {
    void (async () => {
      try {
        const tabId = getCurrentTabId() ?? (await getActiveTabId());
        if (!analyses.get(tabId)) await analyze(tabId);
      } catch {
        // No tab to attach to yet; the first tab event will bring one.
      }
    })();
  });
}
