import { collectApplicationSignals } from "../content/application-signals";
import { getActiveTabId } from "../lib/active-tab";
import { buildApplicationReport } from "../lib/application-heuristics";
import type { ApplicationReport, ApplicationSection, Finding, RawApplicationSignals } from "../lib/application-heuristics";
import type { Limit } from "../lib/limits";
import { createTabStore, getCurrentTabId, onTabActivated, onTabNavigated } from "../lib/tab-state";
import { whenVisible } from "../lib/panel-visibility";
import { BTN, el, H1, pageAccessError, SECTION_LABEL, STATUS } from "./ui";

const BASIS_LABEL: Record<Finding["basis"], string> = {
  observed: "Read off the page",
  pattern: "Matched a pattern",
};

const BASIS_TITLE: Record<Finding["basis"], string> = {
  observed: "A fact taken straight from the page — the element, count or measurement is right there.",
  pattern: "A guess from matching words or domain names against a short list kept in this extension. Not proof, and not exhaustive.",
};

/**
 * One finding as a label row: its title, and a count of the evidence behind it. The sentence that
 * explains it is a tap away rather than gone — a panel that shows only counts has stopped saying
 * why it counted them.
 */
function renderFinding(finding: Finding): HTMLElement {
  const row = el("div", "flex flex-col");

  const head = el(
    "button",
    "flex items-baseline justify-between gap-2 w-full text-left py-0.5 pl-6 pr-3 hover:bg-neutral-800/50",
  );
  const title = el("span", `text-[11px] leading-snug ${finding.basis === "pattern" ? "text-amber-300" : "text-neutral-300"}`, finding.title);
  const count = el(
    "span",
    "shrink-0 text-[11px] text-neutral-400 font-mono tabular-nums",
    finding.evidence.length ? String(finding.evidence.length) : "\u2014",
  );
  head.append(title, count);
  head.title = BASIS_TITLE[finding.basis];
  row.appendChild(head);

  const body = el("div", "flex flex-col gap-1 pl-6 pr-3 pb-2 pt-1");
  body.hidden = true;
  body.append(el("p", "text-[11px] text-neutral-400 leading-relaxed", finding.explanation));
  for (const item of finding.evidence) {
    const line = el("div", "text-[11px] text-neutral-300 leading-snug break-words");
    line.append(el("span", "", item.text));
    if (item.detail) line.append(el("span", "text-muted", ` ${"\u2014"} ${item.detail}`));
    body.appendChild(line);
  }
  body.append(el("p", "text-[10px] text-muted leading-snug pt-0.5", BASIS_LABEL[finding.basis]));
  row.appendChild(body);

  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
  });
  return row;
}

/** One band of the label: its heading, its count, and its findings as rows beneath it. */
function renderSection(section: ApplicationSection, first: boolean): HTMLElement {
  const band = el("div", `flex flex-col ${first ? "" : "border-t border-neutral-700"}`);

  const heading = el("div", "flex items-baseline justify-between gap-2 px-3 pt-2 pb-1");
  heading.append(
    el("span", "text-[11px] font-semibold uppercase tracking-wide text-neutral-100", section.title),
    el("span", "text-sm font-semibold text-neutral-100 tabular-nums", String(section.findings.length)),
  );
  band.appendChild(heading);

  if (!section.findings.length) {
    const empty = el("div", "text-[11px] text-muted leading-snug pl-6 pr-3 pb-2", "nothing matched");
    empty.title = section.emptyNote;
    band.appendChild(empty);
    return band;
  }
  for (const finding of section.findings) band.appendChild(renderFinding(finding));
  band.appendChild(el("div", "pb-1.5"));
  return band;
}

/** The limits, as a strip of chips. Each one keeps its full sentence as the thing it says on hover. */
function renderLimits(limits: readonly Limit[]): HTMLElement {
  const wrap = el("div", "flex flex-col gap-1.5 pt-3 border-t border-neutral-800");
  wrap.append(el("div", SECTION_LABEL, "Blind spots"));
  const strip = el("div", "flex flex-wrap gap-1.5");
  for (const entry of limits) {
    const chip = el(
      "span",
      "inline-flex items-center px-1.5 py-0.5 rounded border border-dashed border-neutral-600 text-neutral-400 text-[11px] leading-snug",
      entry.label,
    );
    chip.title = entry.detail;
    strip.appendChild(chip);
  }
  wrap.appendChild(strip);
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
  const titleRow = el("div", "flex items-baseline justify-between gap-2");
  titleRow.append(el("h1", H1, "Application"));
  const aboutBtn = el("button", "text-[11px] text-neutral-400 hover:text-neutral-200 px-1 py-0.5", "How this reads the page");
  titleRow.appendChild(aboutBtn);
  const about = el(
    "p",
    "text-xs text-neutral-400 leading-relaxed",
    "Reads the page in front of you: what it asks you to type, whose code it loads, where it leans on you to say yes, " +
      "and what it has already stored in your browser. Everything is computed on your machine — nothing about this " +
      "page is sent anywhere, and no value you have typed is read.",
  );
  about.hidden = true;
  aboutBtn.addEventListener("click", () => {
    about.hidden = !about.hidden;
  });
  header.append(titleRow, about);
  root.appendChild(header);

  const toolbar = el("div", "flex items-center gap-2");
  const scanBtn = el("button", BTN, "Scan this page");
  toolbar.appendChild(scanBtn);
  root.appendChild(toolbar);

  const status = el("p", STATUS, "Nothing scanned yet.");
  root.appendChild(status);

  // The label itself: one bordered block, a heavy rule under its head, a thin rule between bands.
  const label = el("div", "flex flex-col border border-neutral-700 rounded overflow-hidden");
  label.hidden = true;
  root.appendChild(label);

  const limitsWrap = el("div", "flex flex-col");
  limitsWrap.hidden = true;
  root.appendChild(limitsWrap);

  const views = createTabStore<ApplicationView>();
  /** Discards a scan whose answer arrived after the reader moved on, the way the inspector does. */
  let runId = 0;

  /** Takes the previous tab's findings off the screen so nothing stale is left under a new host. */
  function clearOutput(): void {
    label.replaceChildren();
    label.hidden = true;
    limitsWrap.replaceChildren();
    limitsWrap.hidden = true;
  }

  function render({ report, signals }: ApplicationView): void {
    const patterns = report.sections.flatMap((section) => section.findings).filter((finding) => finding.basis === "pattern").length;

    const head = el("div", "flex flex-col gap-0.5 px-3 pt-2.5 pb-2 border-b-4 border-neutral-300");
    head.append(
      el("div", "text-xs font-semibold uppercase tracking-widest text-neutral-100", "What this page does"),
      el("div", "text-[11px] font-mono text-neutral-400 break-all", report.host),
    );

    const meta = el("div", "flex items-baseline justify-between gap-2 px-3 py-1.5 border-b border-neutral-700");
    meta.append(
      el(
        "span",
        "text-xs text-neutral-300",
        `${report.findingCount} finding${report.findingCount === 1 ? "" : "s"} across ${report.sections.length} areas`,
      ),
      el(
        "span",
        "text-[11px] text-neutral-400 tabular-nums",
        `${signals.fields.length} input${signals.fields.length === 1 ? "" : "s"} ${"\u00b7"} ${signals.resources.length} resource${signals.resources.length === 1 ? "" : "s"}`,
      ),
    );

    const bands = report.sections.map((section, index) => renderSection(section, index === 0));

    // The basis chip stopped repeating on every finding; the count of guesses is stated once.
    const basis = el("div", "flex items-center justify-between gap-2 px-3 py-2 border-t-4 border-neutral-300");
    const basisLabel = el("span", "text-[11px] text-neutral-400 leading-snug", "Matched a pattern, not proof");
    basisLabel.title = BASIS_TITLE.pattern;
    basis.append(
      basisLabel,
      el("span", "text-[11px] font-semibold text-neutral-100 tabular-nums", `${patterns} of ${report.findingCount}`),
    );

    label.replaceChildren(head, meta, ...bands, basis);
    label.hidden = false;

    limitsWrap.replaceChildren(renderLimits(report.notChecked));
    limitsWrap.append(
      el(
        "p",
        "text-[11px] text-muted leading-snug pt-2",
        "Findings describe what the page does, never whether the site can be trusted. Nothing here is a verdict.",
      ),
    );
    limitsWrap.hidden = false;
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
          : "Nothing matched on this page — read the blind spots below before taking that as an all-clear.",
      };
      views.set(tabId, view);
      render(view);
      status.textContent = view.status;
    } catch (err) {
      if (!stillCurrent(tabId, myRun)) return;
      status.textContent = pageAccessError(err, "scanned");
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
