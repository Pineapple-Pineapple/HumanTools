import { highlightSecurityForm } from "../content/functions";
import { collectSecuritySignals } from "../content/security-signals";
import { getActiveTabId } from "../lib/active-tab";
import {
  ageChip,
  ageSentence,
  describeRecord,
  isRecentRegistration,
  lookupDomain,
  lookupTarget,
  noRecordSentence,
  rdapDisclosure,
  REGISTRATION_ATTRIBUTION,
  REGISTRATION_CAVEAT,
  unavailableSentence,
} from "../lib/domain-lookup";
import type { DomainLookup } from "../lib/domain-lookup";
import {
  destinationSentence,
  resolvableLinks,
  resolveDisclosure,
  resolveLink,
  RESOLVE_ATTRIBUTION,
  RESOLVE_DISCLOSURE,
} from "../lib/link-resolver";
import type { FlaggedLink, LinkResolution } from "../lib/link-resolver";
import type { Limit } from "../lib/limits";
import { emptyFindingsMessage, findingsSummary, groupAsks, readSecuritySignals } from "../lib/security-heuristics";
import type { AskGroup } from "../lib/security-heuristics";
import type { Finding, SecurityReading, SecuritySignals, SensitiveAsk, Severity } from "../lib/security-heuristics";
import { createTabStore, getCurrentTabId, onTabActivated, onTabNavigated } from "../lib/tab-state";
import { whenVisible } from "../lib/panel-visibility";

const SEVERITY_LABEL: Record<Severity, string> = {
  high: "Worth stopping for",
  medium: "Worth knowing",
  low: "Context",
};

const SEVERITY_BAR: Record<Severity, string> = {
  high: "border-l-red-500",
  medium: "border-l-amber-500",
  low: "border-l-neutral-600",
};

const CHIP = "inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] leading-none";
const NEUTRAL_CHIP = `${CHIP} bg-neutral-800 text-neutral-300 border-neutral-600`;
const ATTENTION_CHIP = `${CHIP} bg-amber-950 text-amber-300 border-amber-800`;
const SECTION_LABEL = "text-[11px] uppercase tracking-wide text-muted";
const BTN =
  "inline-flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-neutral-800 border border-neutral-600 rounded text-neutral-100";
const SMALL_BTN =
  "self-start inline-flex items-center gap-1.5 px-2 py-1 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-neutral-800 border border-neutral-600 rounded text-neutral-100 text-xs";
const BODY = "text-xs text-neutral-300 leading-relaxed";
const NOTE = "text-[11px] text-muted leading-snug";

/**
 * Links offered a follow button at once. Every press is a real request from the reader's address,
 * so a page that wraps four hundred links in a shortener gets a list that ends and says so rather
 * than four hundred buttons.
 */
const MAX_RESOLVABLE_SHOWN = 20;

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
    return "This page can't be read — browser pages and extension stores are off-limits to extensions.";
  }
  return message || "Couldn't read this page.";
}

function transportChip(reading: SecurityReading): HTMLElement {
  if (reading.transport === "https") {
    const chip = el("span", NEUTRAL_CHIP, "https — encrypted in transit");
    chip.title = "Encryption in transit only. It says nothing about who runs this site or what they do with what you send.";
    return chip;
  }
  if (reading.transport === "http") {
    return el("span", `${CHIP} bg-red-950 text-red-300 border-red-800`, "http — not encrypted");
  }
  return el("span", NEUTRAL_CHIP, reading.transport);
}

const SEVERITY_DOT: Record<Severity, string> = {
  high: "bg-red-500",
  medium: "bg-amber-500",
  low: "bg-neutral-500",
};

/** The severity mix as one bar, which is what the summary sentence used to say in words. */
function renderSeverityBar(findings: readonly Finding[]): HTMLElement {
  const wrap = el("div", "flex flex-col gap-1.5");
  const counts: Record<Severity, number> = {
    high: findings.filter((finding) => finding.severity === "high").length,
    medium: findings.filter((finding) => finding.severity === "medium").length,
    low: findings.filter((finding) => finding.severity === "low").length,
  };
  const total = findings.length;

  const bar = el("div", "flex h-1.5 rounded-sm overflow-hidden bg-neutral-800");
  for (const severity of ["high", "medium", "low"] as const) {
    if (!counts[severity]) continue;
    const segment = el("div", SEVERITY_DOT[severity]);
    segment.style.width = `${(counts[severity] / total) * 100}%`;
    bar.appendChild(segment);
  }
  wrap.appendChild(bar);

  const legend = el("div", "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-400");
  for (const severity of ["high", "medium", "low"] as const) {
    if (!counts[severity]) continue;
    const item = el("span", "inline-flex items-center gap-1.5");
    item.append(
      el("span", `w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[severity]}`),
      el("span", "", `${counts[severity]} ${SEVERITY_LABEL[severity].toLowerCase()}`),
    );
    legend.appendChild(item);
  }
  wrap.appendChild(legend);
  return wrap;
}

/**
 * One finding as a row. The explanation and its evidence open on tap rather than being dropped:
 * a severity a reader cannot interrogate is a verdict, which is the one thing this panel never is.
 */
function renderFinding(finding: Finding): HTMLElement {
  const row = el("div", `flex flex-col rounded border-l-2 ${SEVERITY_BAR[finding.severity]}`);

  const head = el("button", "flex items-center gap-2 w-full text-left px-2 py-1.5 hover:bg-neutral-800/60");
  head.append(
    el("span", `shrink-0 w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[finding.severity]}`),
    el("span", "grow text-xs text-neutral-100 leading-snug", finding.title),
    el("span", "shrink-0 text-[11px] text-muted", SEVERITY_LABEL[finding.severity]),
  );
  row.appendChild(head);

  const body = el("div", "flex flex-col gap-1.5 pl-5 pr-2 pb-2");
  body.hidden = true;
  body.append(el("p", BODY, finding.explanation));
  for (const item of finding.evidence) {
    const line = el("div", "text-[11px] font-mono text-neutral-400 break-all leading-snug", item);
    line.title = item;
    body.appendChild(line);
  }
  row.appendChild(body);

  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
  });
  return row;
}

/**
 * What the page asks for, drawn as what it is: a direction. Each form is a column carrying the
 * values it collects down to the address it posts them to, so a destination that is not this site
 * is visible as a shape rather than as the end of a sentence.
 */
function renderAsks(asks: readonly SensitiveAsk[], showForm: (group: AskGroup) => void): HTMLElement {
  const section = el("div", "flex flex-col gap-2");
  section.append(el("div", SECTION_LABEL, "What leaves this page"));

  const groups = groupAsks(asks);

  const source = el("div", "flex flex-col items-center gap-0");
  source.append(
    el(
      "span",
      "inline-flex items-center px-2.5 py-1 rounded-full border border-neutral-600 bg-neutral-800 text-xs text-neutral-100",
      "What you type",
    ),
    el("div", "w-px h-3 bg-neutral-600"),
  );
  section.appendChild(source);

  // Three columns is what a 380px panel holds; past that the diagram becomes the same rows, listed.
  const wide = groups.length <= 3;
  const grid = el("div", wide ? "grid gap-2" : "flex flex-col gap-1.5");
  if (wide) grid.style.gridTemplateColumns = `repeat(${Math.max(groups.length, 1)}, minmax(0, 1fr))`;

  for (const group of groups) {
    const away = group.offSite;
    if (wide) {
      const column = el(
        "div",
        `flex flex-col items-center gap-1 rounded border p-2 bg-neutral-800/70 ${away ? "border-red-800" : "border-neutral-700"}`,
      );
      const showBtn = el(
        "button",
        "text-xs text-neutral-100 text-center leading-snug underline decoration-dotted decoration-neutral-500 underline-offset-2 hover:decoration-neutral-300",
        group.formLabel,
      );
      showBtn.title = "Show me this form on the page";
      showBtn.addEventListener("click", () => showForm(group));
      column.append(
        showBtn,
        el("div", `text-[11px] text-center leading-snug ${away ? "text-red-300" : "text-amber-300"}`, group.labels.join(", ")),
        el("div", `w-px h-3 ${away ? "bg-red-500" : "bg-neutral-600"}`),
        el(
          "div",
          `text-[10px] font-mono text-center break-all leading-snug ${away ? "text-red-300" : "text-neutral-300"}`,
          group.destination,
        ),
      );
      if (away) column.append(el("div", "text-[10px] text-red-300 text-center leading-snug", "another site"));
      grid.appendChild(column);
    } else {
      const row = el("div", "flex items-center gap-2 text-[11px] leading-snug");
      const rowBtn = el(
        "button",
        "shrink-0 text-neutral-100 underline decoration-dotted decoration-neutral-500 underline-offset-2 hover:decoration-neutral-300",
        group.formLabel,
      );
      rowBtn.title = "Show me this form on the page";
      rowBtn.addEventListener("click", () => showForm(group));
      row.append(
        rowBtn,
        el("span", `grow ${away ? "text-red-300" : "text-amber-300"}`, group.labels.join(", ")),
        el("span", `shrink-0 font-mono break-all ${away ? "text-red-300" : "text-neutral-400"}`, group.destination),
      );
      grid.appendChild(row);
    }
  }
  section.appendChild(grid);

  const note = el("p", NOTE, "Destinations are the addresses written in the markup, not where the data travels after that.");
  note.title =
    "Read from the field names and types in the page. Nothing you have typed is read, and the destination is the address written in the markup, not wherever the data travels after that.";
  section.appendChild(note);
  return section;
}

/** The limits, as chips. Each keeps its full sentence as the thing it says on hover. */
function renderLimits(limits: readonly Limit[]): HTMLElement {
  const wrap = el("div", "flex flex-col gap-1.5");
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

// ---- The two checks that reach the network -----------------------------------------------------
// Both are buttons and only buttons. Nothing below is called by the scan, and each one prints what
// it will send, and to whom, above the control that sends it. Results are attributed to the network
// so they are never mistaken for something read off the page.

function renderDomainRecord(lookup: DomainLookup, askedAt: Date): HTMLElement {
  const box = el("div", "flex flex-col gap-1.5 rounded bg-neutral-800/70 border border-neutral-700 p-3");

  if (lookup.state === "no_record") {
    box.append(el("p", BODY, noRecordSentence(lookup.domain)));
    box.append(el("p", NOTE, `Asked at ${askedAt.toLocaleTimeString()}. ${REGISTRATION_ATTRIBUTION}`));
    return box;
  }
  if (lookup.state === "unavailable") {
    box.append(el("p", BODY, unavailableSentence(lookup.domain, lookup.detail)));
    box.append(el("p", NOTE, `Asked at ${askedAt.toLocaleTimeString()}.`));
    return box;
  }
  if (lookup.state === "not_a_domain") {
    box.append(el("p", BODY, `Nothing was sent: ${lookup.detail}.`));
    return box;
  }

  const record = lookup.record;
  const head = el("div", "flex flex-wrap items-center gap-2");
  head.append(
    el("span", "text-neutral-100 font-mono text-xs break-all", record.name),
    el("span", isRecentRegistration(record) ? ATTENTION_CHIP : NEUTRAL_CHIP, ageChip(record)),
  );
  box.append(head);
  box.append(el("p", "text-sm text-neutral-100 leading-snug", ageSentence(record)));

  const rows = describeRecord(record);
  if (rows.length) {
    const table = el("div", "flex flex-col gap-1 pt-1 border-t border-neutral-700/60");
    for (const row of rows) {
      const line = el("div", "text-[11px] text-neutral-400 leading-snug");
      line.append(el("span", "text-muted", `${row.label}: `), el("span", "font-mono break-all", row.value));
      table.appendChild(line);
    }
    box.appendChild(table);
  } else {
    box.append(el("p", NOTE, "The registry answered, but its record carries no dates, no registrar and no status."));
  }

  box.append(el("p", NOTE, REGISTRATION_CAVEAT));
  box.append(el("p", NOTE, `Asked at ${askedAt.toLocaleTimeString()}. ${REGISTRATION_ATTRIBUTION}`));
  return box;
}

function renderDomainLookup(reading: SecurityReading): HTMLElement {
  const block = el("div", "flex flex-col gap-2");
  block.append(el("div", SECTION_LABEL, "How old is this domain, and who sold it?"));

  const domain = lookupTarget(reading.hostname);
  if (!domain) {
    block.append(
      el(
        "p",
        BODY,
        `There is no registered domain name in ${reading.hostname || "this address"} to ask about — a bare IP address or a local name has no registration record. Nothing would be sent, so there is no button here.`,
      ),
    );
    return block;
  }

  block.append(el("p", BODY, rdapDisclosure(domain)));
  const button = el("button", SMALL_BTN, `Look up ${domain} at rdap.org`);
  block.appendChild(button);
  const result = el("div", "flex flex-col gap-1.5");
  result.hidden = true;
  block.appendChild(result);

  button.addEventListener("click", async () => {
    button.disabled = true;
    result.replaceChildren(el("p", NOTE, `Asking rdap.org about ${domain}…`));
    result.hidden = false;
    const lookup = await lookupDomain(domain);
    result.replaceChildren(renderDomainRecord(lookup, new Date()));
    button.disabled = false;
    button.textContent = `Look up ${domain} again`;
  });

  return block;
}

function renderResolution(resolution: LinkResolution, askedAt: Date): HTMLElement {
  const box = el("div", "flex flex-col gap-1 pt-1 border-t border-neutral-700/60");
  box.append(el("p", "text-xs text-neutral-100 leading-relaxed", destinationSentence(resolution)));
  if (resolution.state === "resolved") {
    box.append(el("p", NOTE, `Followed at ${askedAt.toLocaleTimeString()}. ${RESOLVE_ATTRIBUTION}`));
  } else if (resolution.state === "failed") {
    box.append(el("p", NOTE, `Tried at ${askedAt.toLocaleTimeString()}. The request was made; nothing usable came back.`));
  }
  return box;
}

function renderFlaggedLink(link: FlaggedLink): HTMLElement {
  const card = el("div", "flex flex-col gap-1.5 rounded bg-neutral-800/70 border border-neutral-700 p-2");

  const head = el("div", "flex flex-wrap items-center gap-2");
  head.append(el("span", "text-xs text-neutral-100 leading-snug", link.text ? `“${link.text}”` : "(link with no text)"));
  head.append(el("span", NEUTRAL_CHIP, link.reasonLabel));
  card.appendChild(head);

  const href = el("div", "text-[11px] font-mono text-neutral-400 break-all leading-snug", link.href);
  href.title = link.href;
  card.appendChild(href);
  if (link.frameUrl) card.append(el("div", NOTE, `In frame ${link.frameUrl}`));

  const button = el("button", SMALL_BTN, "Follow it and report where it lands");
  button.title = resolveDisclosure(link.href);
  card.append(el("div", NOTE, resolveDisclosure(link.href)), button);

  const result = el("div", "flex flex-col gap-1");
  result.hidden = true;
  card.appendChild(result);

  button.addEventListener("click", async () => {
    button.disabled = true;
    result.replaceChildren(el("p", NOTE, `Requesting ${link.href}…`));
    result.hidden = false;
    const resolution = await resolveLink(link.href);
    result.replaceChildren(renderResolution(resolution, new Date()));
    button.disabled = false;
    button.textContent = "Follow it again";
  });

  return card;
}

function renderLinkResolver(signals: SecuritySignals, frames: readonly SecuritySignals[]): HTMLElement {
  const block = el("div", "flex flex-col gap-2");
  block.append(el("div", SECTION_LABEL, "Where does a link actually land?"));

  const flagged = resolvableLinks(signals, frames);
  if (flagged.length === 0) {
    block.append(
      el(
        "p",
        BODY,
        "No link on this page is a shortener, an encoded name, or text that disagrees with where it points, so there is nothing here worth spending a request on. The addresses of the rest are already readable above.",
      ),
    );
    return block;
  }

  block.append(el("p", BODY, RESOLVE_DISCLOSURE));
  const shown = flagged.slice(0, MAX_RESOLVABLE_SHOWN);
  for (const link of shown) block.appendChild(renderFlaggedLink(link));
  const hidden = flagged.length - shown.length;
  if (hidden > 0) {
    block.append(el("p", NOTE, `${hidden} more flagged link${hidden === 1 ? "" : "s"} on this page ${hidden === 1 ? "is" : "are"} not listed here.`));
  }
  return block;
}

/**
 * The network block, built once per scan. Nothing here fires on its own: every request is behind a
 * button, so a scan that runs because the reader switched tabs contacts nobody.
 */
function buildNetworkChecks(reading: SecurityReading, signals: SecuritySignals, frames: readonly SecuritySignals[]): Node[] {
  return [
    el("div", SECTION_LABEL, "Checks that reach the network — only when you press them"),
    el(
      "p",
      NOTE,
      "Everything above this line was worked out on your machine from the page's own markup. Nothing below has run yet. Each button below sends a request, says what it sends, and reports the answer as having come from the network rather than from the page.",
    ),
    renderDomainLookup(reading),
    renderLinkResolver(signals, frames),
  ];
}

/**
 * One tab's finished check. The network block is kept as live DOM rather than rebuilt: a lookup the
 * reader chose to pay for stays on screen when they leave the tab and come back, and re-showing it
 * sends nothing, where rebuilding it would throw the answer away.
 */
interface SecurityView {
  reading: SecurityReading;
  network: Node[];
  status: string;
  /**
   * Which frame each document came back from, keyed by its address ("" is the top page). A form
   * inside a frame can only be highlighted by injecting into that same frame.
   */
  frameIds: Record<string, number>;
}

export function mountSecurityPanel(container: HTMLElement): void {
  const root = el("div", "p-4 flex flex-col gap-4 text-sm");
  container.appendChild(root);

  const header = el("div", "flex flex-col gap-1.5");
  const titleRow = el("div", "flex items-baseline justify-between gap-2");
  titleRow.append(el("h1", "text-neutral-100 font-medium", "Security"));
  const aboutBtn = el("button", "text-[11px] text-neutral-400 hover:text-neutral-200 px-1 py-0.5", "How this reads the page");
  titleRow.appendChild(aboutBtn);
  const about = el("div", "flex flex-col gap-1.5");
  about.hidden = true;
  about.append(
    el(
      "p",
      "text-xs text-neutral-400 leading-relaxed",
      "Reads what the page itself shows: where it is served from, where its forms post, where its links go, and whose " +
        "code runs on it. Every finding names the evidence it came from. It does not decide whether this page can be " +
        "trusted — nothing here checks who runs it. The scan is local: it runs on your machine, sends nothing anywhere, " +
        "and reads no value you have typed.",
    ),
    el(
      "p",
      "text-xs text-neutral-400 leading-relaxed",
      "Two questions cannot be answered from the page — how old the domain is, and where a redirecting link ends up. " +
        "Each is a button, each says what it sends and to whom before you press it, and neither fires on its own. If you " +
        "never press one, nothing about this page leaves your machine.",
    ),
  );
  aboutBtn.addEventListener("click", () => {
    about.hidden = !about.hidden;
  });
  header.append(titleRow, about);
  root.appendChild(header);

  const toolbar = el("div", "flex items-center gap-2");
  const checkBtn = el("button", BTN, "Check this page");
  toolbar.appendChild(checkBtn);
  root.appendChild(toolbar);

  const status = el("p", "text-xs text-muted min-h-[1em]", "Nothing checked yet.");
  root.appendChild(status);

  const origin = el("div", "flex flex-col gap-2");
  origin.hidden = true;
  root.appendChild(origin);

  const summary = el("div", "flex flex-col gap-1.5");
  summary.hidden = true;
  root.appendChild(summary);

  const findingsSection = el("div", "flex flex-col gap-0.5");
  root.appendChild(findingsSection);

  const asksSection = el("div", "flex flex-col gap-1.5 pt-3 border-t border-neutral-800");
  asksSection.hidden = true;
  root.appendChild(asksSection);

  const networkSection = el("div", "flex flex-col gap-3 pt-3 border-t border-neutral-800");
  networkSection.hidden = true;
  root.appendChild(networkSection);

  const limitsSection = el("div", "flex flex-col gap-1.5 pt-3 border-t border-neutral-800");
  limitsSection.hidden = true;
  root.appendChild(limitsSection);

  const views = createTabStore<SecurityView>();
  /** Discards a check whose answer arrived after the reader moved on, the way the inspector does. */
  let runId = 0;

  /** Takes the previous tab's findings off the screen so nothing stale is left under a new host. */
  function clearOutput(): void {
    origin.hidden = true;
    summary.hidden = true;
    findingsSection.replaceChildren();
    networkSection.replaceChildren();
    networkSection.hidden = true;
    asksSection.hidden = true;
    limitsSection.hidden = true;
  }

  /** One number and what it counts. The counts line used to say all four in a sentence. */
  function vital(value: number, label: string, attention = false): HTMLElement {
    const cell = el("div", "flex flex-col gap-0.5 min-w-0");
    cell.append(
      el("div", `text-xl leading-none font-semibold tabular-nums ${attention ? "text-amber-300" : "text-neutral-100"}`, String(value)),
      el("div", "text-[10px] uppercase tracking-wide text-neutral-400 truncate", label),
    );
    return cell;
  }

  function render(view: SecurityView): void {
    const { reading } = view;

    const hostRow = el("div", "flex flex-wrap items-center gap-2");
    hostRow.append(
      el("span", "text-neutral-100 font-mono text-xs break-all", reading.hostname || "(no hostname)"),
      transportChip(reading),
    );
    const urlRow = el("div", "text-[11px] font-mono text-muted break-all", reading.url);
    urlRow.title = reading.url;

    const vitals = el("div", "grid grid-cols-4 gap-2 py-2.5 border-y border-neutral-800");
    vitals.append(
      vital(reading.counts.forms, "Forms"),
      vital(reading.counts.links, "Links"),
      vital(reading.counts.thirdPartyOrigins, "Outside"),
      vital(reading.asks.length, "Asks", reading.asks.length > 0),
    );
    origin.replaceChildren(hostRow, urlRow, vitals);
    origin.hidden = false;

    summary.replaceChildren();
    if (reading.findings.length) {
      const bar = renderSeverityBar(reading.findings);
      // The sentence the bar replaced is still the thing it means, so it stays as its title.
      bar.title = findingsSummary(reading.findings);
      summary.appendChild(bar);
    } else {
      summary.appendChild(el("p", BODY, emptyFindingsMessage()));
    }
    summary.hidden = false;

    findingsSection.replaceChildren();
    for (const finding of reading.findings) findingsSection.appendChild(renderFinding(finding));

    asksSection.replaceChildren();
    if (reading.asks.length) {
      asksSection.appendChild(renderAsks(reading.asks, (group) => void showForm(view, group)));
      asksSection.hidden = false;
    } else {
      asksSection.hidden = true;
    }

    networkSection.replaceChildren(...view.network);
    networkSection.hidden = false;

    limitsSection.replaceChildren(renderLimits(reading.notChecked));
    limitsSection.hidden = false;
  }

  /**
   * Points the reader at the form itself. The check stamped nothing on the page, so the form is
   * found by repeating the count the collector made, in the frame it was counted in.
   */
  async function showForm(view: SecurityView, group: AskGroup): Promise<void> {
    const tabId = getCurrentTabId();
    if (tabId === null) return;
    const frameId = view.frameIds[group.frameUrl];
    if (frameId === undefined) {
      status.textContent = "That frame is no longer on this page.";
      return;
    }
    try {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: highlightSecurityForm,
        args: [group.formIndex, group.formAction],
      });
      if (injected?.result === "shown") {
        status.textContent = `Outlined ${group.formLabel} on the page.`;
      } else if (injected?.result === "changed") {
        status.textContent = "That form now posts somewhere else than when this page was read. Check the page again.";
      } else {
        status.textContent = "That form is no longer on the page.";
      }
    } catch (err) {
      status.textContent = pageAccessError(err);
    }
  }

  /** Still the tab the reader is looking at? Null means the panel has not resolved one yet. */
  function stillCurrent(tabId: number, myRun: number): boolean {
    const current = getCurrentTabId();
    return myRun === runId && (current === null || current === tabId);
  }

  async function check(tabId: number): Promise<void> {
    const myRun = ++runId;
    checkBtn.disabled = true;
    clearOutput();
    status.textContent = "Reading this page…";
    try {
      // allFrames: true runs the collector in every frame the extension can reach, including
      // cross-origin ones — the host permissions already cover them. Each frame answers separately
      // and stays separate: the top document is frame 0, everything else is attributed to its own
      // address so a form inside a third-party frame is never read as the page's own.
      const injected = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: collectSecuritySignals,
      });
      if (!stillCurrent(tabId, myRun)) return;
      const collected = injected.filter((entry): entry is typeof entry & { result: SecuritySignals } => Boolean(entry.result));
      const top = collected.find((entry) => entry.frameId === 0) ?? collected[0];
      if (!top) {
        status.textContent = "Nothing came back from this page.";
        return;
      }
      const subframes = collected.filter((entry) => entry !== top).map((entry) => entry.result);
      const frameIds: Record<string, number> = { "": top.frameId };
      for (const entry of collected) frameIds[entry.result.url] = entry.frameId;
      const frameNote = subframes.length
        ? ` Read the top page and ${subframes.length} frame${subframes.length === 1 ? "" : "s"} inside it.`
        : "";
      const reading = readSecuritySignals(top.result, subframes);
      const view: SecurityView = {
        reading,
        network: buildNetworkChecks(reading, top.result, subframes),
        frameIds,
        status: `Read at ${new Date().toLocaleTimeString()}.${frameNote} This is a snapshot; the page can change after it.`,
      };
      views.set(tabId, view);
      render(view);
      status.textContent = view.status;
    } catch (err) {
      if (!stillCurrent(tabId, myRun)) return;
      status.textContent = pageAccessError(err);
    } finally {
      if (myRun === runId) checkBtn.disabled = false;
    }
  }

  async function checkCurrentTab(): Promise<void> {
    await check(getCurrentTabId() ?? (await getActiveTabId()));
  }

  checkBtn.addEventListener("click", () => void checkCurrentTab());

  // The panel outlives the tab it was opened over. Switching tabs swaps in what this tab already
  // showed, or checks it — the check is local and sends nothing, so it costs the reader nothing.
  onTabActivated((tabId) => {
    const view = views.get(tabId);
    if (!view) {
      // Reading a page means injecting into every frame of it, so a panel nobody is looking at
      // waits its turn rather than doing that on every switch for the life of the side panel.
      whenVisible(container, () => void check(tabId));
      return;
    }
    runId++; // anything still in flight belongs to the tab the reader just left
    checkBtn.disabled = false;
    render(view);
    status.textContent = view.status;
  });

  // Navigating drops this tab's entry in the store, so there is nothing to restore — read the page
  // the reader is now on. A fresh read never presses the two network buttons; it only rebuilds them.
  onTabNavigated((tabId) => whenVisible(container, () => void check(tabId)));
}
