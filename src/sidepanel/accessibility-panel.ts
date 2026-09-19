import { computeFleschKincaidGrade } from "../lib/flesch-kincaid";
import { extractPageBlocks } from "../content/functions";
import type { PageModel } from "../lib/types";

interface AccessibilityPanelEls {
  root: HTMLElement;
  analyzeBtn: HTMLButtonElement;
  gradeReadout: HTMLElement;
  gradeSelect: HTMLSelectElement;
  rewriteBtn: HTMLButtonElement;
  restoreBtn: HTMLButtonElement;
  status: HTMLElement;
  optionsLink: HTMLButtonElement;
}

function renderAccessibilityPanel(container: HTMLElement): AccessibilityPanelEls {
  const root = document.createElement("div");
  root.className = "p-4 flex flex-col gap-3 text-sm";

  const heading = document.createElement("h1");
  heading.textContent = "Accessibility — make this understandable";
  heading.className = "text-neutral-100 font-medium";

  const analyzeBtn = document.createElement("button");
  analyzeBtn.textContent = "Analyze this page";
  analyzeBtn.className =
    "self-start px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 border border-neutral-600 rounded text-neutral-100";

  const gradeReadout = document.createElement("p");
  gradeReadout.className = "text-neutral-400";
  gradeReadout.textContent = "Reading grade: —";

  const gradeRow = document.createElement("label");
  gradeRow.className = "flex items-center gap-2 text-neutral-300";
  const gradeLabel = document.createElement("span");
  gradeLabel.textContent = "Rewrite for grade";
  const gradeSelect = document.createElement("select");
  gradeSelect.className = "bg-neutral-800 border border-neutral-600 rounded px-1.5 py-1";
  gradeSelect.disabled = true;
  for (const grade of [6, 9, 12]) {
    const opt = document.createElement("option");
    opt.value = String(grade);
    opt.textContent = String(grade);
    if (grade === 9) opt.selected = true;
    gradeSelect.appendChild(opt);
  }
  gradeRow.append(gradeLabel, gradeSelect);

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
  optionsLink.textContent = "Set OpenRouter API key";
  optionsLink.className = "self-start text-xs text-amber-500 hover:underline";

  root.append(heading, analyzeBtn, gradeReadout, gradeRow, actionRow, status, optionsLink);
  container.appendChild(root);

  return { root, analyzeBtn, gradeReadout, gradeSelect, rewriteBtn, restoreBtn, status, optionsLink };
}

async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  return tab.id;
}

export function mountAccessibilityPanel(container: HTMLElement): void {
  const els = renderAccessibilityPanel(container);
  let pageModel: PageModel | null = null;

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
      els.gradeSelect.disabled = false;
      els.rewriteBtn.disabled = false;
      els.status.textContent = `${pageModel.blocks.length} paragraphs analyzed.`;
    } catch (err) {
      els.status.textContent = err instanceof Error ? err.message : "Analysis failed.";
    } finally {
      els.analyzeBtn.disabled = false;
    }
  });
}
