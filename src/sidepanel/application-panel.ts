import { collectApplicationSignals } from "../content/application-signals";
import { getActiveTabId } from "../lib/active-tab";
import { buildApplicationReport } from "../lib/application-heuristics";
import type { ApplicationReport, ApplicationSection, Finding, RawApplicationSignals } from "../lib/application-heuristics";
import { createTabStore, getCurrentTabId, onTabActivated, onTabNavigated } from "../lib/tab-state";
import { whenVisible } from "../lib/panel-visibility";

const CHIP = "inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] leading-none";
const SECTION_LABEL = "text-[11px] uppercase tracking-wide text-neutral-500";
const BTN =
  "inline-flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-neutral-800 border border-neutral-600 rounded text-neutral-100";

const BASIS_CHIP: Record<Finding["basis"], string> = {
  observed: `${CHIP} bg-neutral-800 text-neutral-300 border-neutral-600`,
  pattern: `${CHIP} bg-amber-950 text-amber-300 border-amber-800`,
};

const BASIS_LABEL: Record<Finding["basis"], string> = {
  observed: "Read off the page",
  pattern: "Matched a pattern",
};

const BASIS_TITLE: Record<Finding["basis"], string> = {
  observed: "A fact taken straight from the page — the element, count or measurement is right there.",
  pattern: "A guess from matching words or domain names against a short list kept in this extension. Not proof, and not exhaustive.",
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
    return "This page can't be scanned — browser pages and extension stores are off-limits to extensions.";
  }
  return message || "Couldn't read this page.";
}

function renderFinding(finding: Finding): HTMLElement {
  const card = el("div", "flex flex-col gap-2 rounded bg-neutral-800/70 border border-neutral-700 p-3");

  const top = el("div", "flex items-start justify-between gap-2");
  top.append(el("div", "text-neutral-100 font-medium leading-snug min-w-0", finding.title));
  const basis = el("span", `shrink-0 ${BASIS_CHIP[finding.basis]}`, BASIS_LABEL[finding.basis]);
  basis.title = BASIS_TITLE[finding.basis];
  top.appendChild(basis);
  card.appendChild(top);

  card.appendChild(el("p", "text-xs text-neutral-400 leading-relaxed", finding.explanation));

  if (finding.evidence.length) {
    const evidence = el("div", "flex flex-col gap-1 pt-1 border-t border-neutral-700/60");
    evidence.appendChild(el("div", SECTION_LABEL, "On this page"));
    for (const item of finding.evidence) {
      const row = el("div", "text-xs text-neutral-300 leading-snug break-words");
      row.appendChild(el("span", "", item.text));
      if (item.detail) row.appendChild(el("span", "text-neutral-500", ` — ${item.detail}`));
      evidence.appendChild(row);
    }
    card.appendChild(evidence);
  }
  return card;
}

function renderSection(section: ApplicationSection): HTMLElement {
  const wrap = el("div", "flex flex-col gap-2");
  const heading = el("div", "flex items-baseline justify-between gap-2");
  heading.append(
    el("div", SECTION_LABEL, section.title),
    el("span", "text-[11px] text-neutral-500", section.findings.length ? String(section.findings.length) : "nothing found"),
  );
  wrap.appendChild(heading);

  if (!section.findings.length) {
    wrap.appendChild(el("p", "text-xs text-neutral-500 leading-snug", section.emptyNote));
    return wrap;
  }
  for (const finding of section.findings) wrap.appendChild(renderFinding(finding));
  return wrap;
}

function looksLikeSignals(value: unknown): value is RawApplicationSignals {
  const candidate = value as RawApplicationSignals | null;
  return (
    !!candidate &&
    typeof candidate === "object" &&
    Array.isArray(candidate.fields) &&
    Array.isArray(candidate.resources) &&
    Array.isArray(candidate.permissions) &&
    Array.isArray(candidate.controls)
  );
}

/** One tab's finished scan, kept so returning to that tab is a re-render rather than a re-read. */
interface ApplicationView {
  report: ApplicationReport;
  signals: RawApplicationSignals;
  status: string;
}

export function mountApplicationPanel(container: HTMLElement): void {
  const root = el("div", "p-4 flex flex-col gap-4 text-sm");
  container.appendChild(root);

  const header = el("div", "flex flex-col gap-1.5");
  header.append(el("h1", "text-neutral-100 font-medium", "Application — what is this site doing with me?"));
  header.append(
    el(
      "p",
      "text-xs text-neutral-400 leading-relaxed",
      "Reads the page in front of you: what it asks you to type, whose code it loads, where it leans on you to say yes, " +
        "and what it has already stored in your browser. Everything is computed on your machine — nothing about this " +
        "page is sent anywhere, and no value you have typed is read.",
    ),
  );
  root.appendChild(header);

  const toolbar = el("div", "flex items-center gap-2");
  const scanBtn = el("button", BTN, "Scan this page");
  toolbar.appendChild(scanBtn);
  root.appendChild(toolbar);

  const status = el("p", "text-xs text-neutral-500 min-h-[1em]", "Nothing scanned yet.");
  root.appendChild(status);

  const scanned = el("div", "flex flex-col gap-1");
  scanned.hidden = true;
  root.appendChild(scanned);

  const sectionsWrap = el("div", "flex flex-col gap-5");
  root.appendChild(sectionsWrap);

  const footer = el("div", "flex flex-col gap-1.5 pt-3 border-t border-neutral-800");
  footer.hidden = true;
  root.appendChild(footer);

  const views = createTabStore<ApplicationView>();
  /** Discards a scan whose answer arrived after the reader moved on, the way the inspector does. */
  let runId = 0;

  /** Takes the previous tab's findings off the screen so nothing stale is left under a new host. */
  function clearOutput(): void {
    scanned.hidden = true;
    sectionsWrap.replaceChildren();
    footer.hidden = true;
  }

  function render({ report, signals }: ApplicationView): void {
    scanned.replaceChildren(
      el("div", SECTION_LABEL, "Scanned"),
      el("div", "text-xs text-neutral-100 font-mono break-all", report.host),
      el(
        "div",
        "text-[11px] text-neutral-500",
        `${signals.formCount} form${signals.formCount === 1 ? "" : "s"} · ${signals.fields.length} input${signals.fields.length === 1 ? "" : "s"} · ` +
          `${signals.resources.length} loaded resource${signals.resources.length === 1 ? "" : "s"} · ${report.findingCount} finding${report.findingCount === 1 ? "" : "s"}`,
      ),
    );
    scanned.hidden = false;

    sectionsWrap.replaceChildren();
    for (const section of report.sections) sectionsWrap.appendChild(renderSection(section));

    footer.replaceChildren(el("div", SECTION_LABEL, "What we could not check"));
    for (const line of report.notChecked) {
      footer.appendChild(el("p", "text-[11px] text-neutral-500 leading-snug", line));
    }
    footer.appendChild(
      el(
        "p",
        "text-[11px] text-neutral-500 leading-snug pt-1",
        "Findings describe what the page does, never whether the site can be trusted. Nothing here is a verdict.",
      ),
    );
    footer.hidden = false;
  }

  /** Still the tab the reader is looking at? Null means the panel has not resolved one yet. */
  function stillCurrent(tabId: number, myRun: number): boolean {
    const current = getCurrentTabId();
    return myRun === runId && (current === null || current === tabId);
  }

  async function scan(tabId: number): Promise<void> {
    const myRun = ++runId;
    scanBtn.disabled = true;
    clearOutput();
    status.textContent = "Reading the page…";
    try {
      const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: collectApplicationSignals });
      if (!stillCurrent(tabId, myRun)) return;
      const result = injection?.result;
      if (!looksLikeSignals(result)) {
        // A collector that threw inside the page comes back as undefined; saying "nothing found"
        // here would be the panel inventing an all-clear it never earned.
        status.textContent = "The page did not return readable signals, so nothing was checked.";
        return;
      }

      const report = buildApplicationReport(result);
      const view: ApplicationView = {
        report,
        signals: result,
        status: report.findingCount
          ? `${report.findingCount} thing${report.findingCount === 1 ? "" : "s"} worth knowing about this page.`
          : "Nothing matched on this page — read the limits below before taking that as an all-clear.",
      };
      views.set(tabId, view);
      render(view);
      status.textContent = view.status;
    } catch (err) {
      if (!stillCurrent(tabId, myRun)) return;
      status.textContent = pageAccessError(err);
    } finally {
      if (myRun === runId) scanBtn.disabled = false;
    }
  }

  async function scanCurrentTab(): Promise<void> {
    await scan(getCurrentTabId() ?? (await getActiveTabId()));
  }

  scanBtn.addEventListener("click", () => void scanCurrentTab());

  // The panel outlives the tab it was opened over. Switching tabs swaps in what this tab already
  // showed, or scans it — the scan is local and sends nothing, so it costs the reader nothing.
  onTabActivated((tabId) => {
    const view = views.get(tabId);
    if (!view) {
      // A panel nobody is looking at doesn't reach into the page; it catches up when shown.
      whenVisible(container, () => void scan(tabId));
      return;
    }
    runId++; // anything still in flight belongs to the tab the reader just left
    scanBtn.disabled = false;
    render(view);
    status.textContent = view.status;
  });

  // Navigating drops this tab's entry in the store, so there is nothing to restore — read the page
  // the reader is now on.
  onTabNavigated((tabId) => whenVisible(container, () => void scan(tabId)));
}
