import { computeFleschKincaidGrade } from "../lib/flesch-kincaid";
import { extractPageBlocks, applyRewrites, applyBullets, restoreOriginal } from "../content/functions";
import { startRewrite } from "../lib/messages";
import { getActiveTabId } from "../lib/active-tab";
import { hasApiKey } from "../lib/provider";
import type { Grade, PageModel, RewriteFormat } from "../lib/types";

const GRADE_STEPS: Grade[] = [6, 8, 10, 12];
const DEFAULT_GRADE: Grade = 8;

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
  let pageModel: PageModel | null = null;

  els.optionsLink.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  els.gradeSlider.addEventListener("input", () => {
    els.gradeValue.textContent = els.gradeSlider.value;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    const relevant = "openaiApiKey" in changes || "openrouterApiKey" in changes || "provider" in changes;
    if (area !== "local" || !relevant || !pageModel) return;
    hasApiKey().then((keyPresent) => {
      els.rewriteBtn.disabled = !keyPresent;
      els.rewriteBtn.title = keyPresent ? "" : "Set an API key first.";
    });
  });

  els.analyzeBtn.addEventListener("click", async () => {
    els.status.textContent = "Analyzing…";
    els.analyzeBtn.disabled = true;
    try {
      const tabId = await getActiveTabId();
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractPageBlocks,
      });
      pageModel = result ?? null;

      if (!pageModel || pageModel.blocks.length === 0) {
        els.status.textContent = "No paragraph text found on this page.";
        return;
      }

      const grade = computeFleschKincaidGrade(pageModel.blocks.map((b) => b.text).join(" "));
      els.gradeReadout.textContent = `Reading grade: ${grade}`;
      els.gradeSlider.disabled = false;
      els.bulletsCheckbox.disabled = false;

      const keyPresent = await hasApiKey();
      els.rewriteBtn.disabled = !keyPresent;
      els.rewriteBtn.title = keyPresent ? "" : "Set an API key first.";
      els.status.textContent = keyPresent
        ? `${pageModel.blocks.length} paragraphs analyzed.`
        : `${pageModel.blocks.length} paragraphs analyzed. Set an API key to rewrite.`;
    } catch (err) {
      els.status.textContent = err instanceof Error ? err.message : "Analysis failed.";
    } finally {
      els.analyzeBtn.disabled = false;
    }
  });

  els.rewriteBtn.addEventListener("click", async () => {
    if (!pageModel || pageModel.blocks.length === 0) return;
    const grade = Number(els.gradeSlider.value) as Grade;
    const format: RewriteFormat = els.bulletsCheckbox.checked ? "bullets" : "prose";
    const tabId = await getActiveTabId();

    els.status.textContent = `Rewriting… 0/${pageModel.blocks.length} paragraphs`;
    els.rewriteBtn.disabled = true;
    els.gradeSlider.disabled = true;
    els.bulletsCheckbox.disabled = true;
    let restoreShown = false;

    startRewrite(pageModel.blocks, grade, format, {
      onProgress: (msg) => {
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
        if (!restoreShown) {
          els.restoreBtn.hidden = false;
          restoreShown = true;
        }
        els.status.textContent = `Rewriting… ${msg.done}/${msg.total} paragraphs`;
      },
      onParagraphError: (msg) => {
        els.status.textContent = `Rewriting… ${msg.done}/${msg.total} paragraphs`;
      },
      onDone: (msg) => {
        els.status.textContent =
          msg.failed > 0
            ? `Rewrote ${msg.succeeded}/${msg.succeeded + msg.failed} paragraphs at grade ${grade} (${msg.failed} failed). Hover a paragraph to see the original.`
            : `Rewrote ${msg.succeeded} paragraphs at grade ${grade}. Hover a paragraph to see the original.`;
        els.rewriteBtn.disabled = false;
        els.gradeSlider.disabled = false;
        els.bulletsCheckbox.disabled = false;
      },
      onFatalError: (msg) => {
        els.status.textContent = msg.message;
        els.rewriteBtn.disabled = false;
        els.gradeSlider.disabled = false;
        els.bulletsCheckbox.disabled = false;
      },
    });
  });

  els.restoreBtn.addEventListener("click", async () => {
    try {
      const tabId = await getActiveTabId();
      await chrome.scripting.executeScript({ target: { tabId }, func: restoreOriginal });
      els.restoreBtn.hidden = true;
      els.status.textContent = "Original text restored.";
    } catch (err) {
      els.status.textContent = err instanceof Error ? err.message : "Restore failed.";
    }
  });
}
