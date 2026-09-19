import { collectSecuritySignals } from "../content/security-signals";
import { getActiveTabId } from "../lib/active-tab";
import { emptyFindingsMessage, findingsSummary, readSecuritySignals } from "../lib/security-heuristics";
import type { Finding, SecurityReading, SensitiveAsk, Severity } from "../lib/security-heuristics";

const SEVERITY_LABEL: Record<Severity, string> = {
  high: "Worth stopping for",
  medium: "Worth knowing",
  low: "Context",
};

const SEVERITY_CHIP: Record<Severity, string> = {
  high: "bg-red-950 text-red-300 border-red-800",
  medium: "bg-amber-950 text-amber-300 border-amber-800",
  low: "bg-neutral-800 text-neutral-300 border-neutral-600",
};

const SEVERITY_BAR: Record<Severity, string> = {
  high: "border-l-red-500",
  medium: "border-l-amber-500",
  low: "border-l-neutral-600",
};

const CHIP = "inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] leading-none";
const SECTION_LABEL = "text-[11px] uppercase tracking-wide text-neutral-500";
const BTN =
  "inline-flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-neutral-800 border border-neutral-600 rounded text-neutral-100";

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
    const chip = el("span", `${CHIP} bg-neutral-800 text-neutral-300 border-neutral-600`, "https — encrypted in transit");
    chip.title = "Encryption in transit only. It says nothing about who runs this site or what they do with what you send.";
    return chip;
  }
  if (reading.transport === "http") {
    return el("span", `${CHIP} bg-red-950 text-red-300 border-red-800`, "http — not encrypted");
  }
  return el("span", `${CHIP} bg-neutral-800 text-neutral-300 border-neutral-600`, reading.transport);
}

function renderFinding(finding: Finding): HTMLElement {
  const card = el(
    "div",
    `flex flex-col gap-2 rounded bg-neutral-800/70 border border-neutral-700 border-l-2 ${SEVERITY_BAR[finding.severity]} p-3`,
  );
  card.append(el("div", "text-neutral-100 font-medium leading-snug", finding.title));
  card.append(el("span", `self-start ${CHIP} ${SEVERITY_CHIP[finding.severity]}`, SEVERITY_LABEL[finding.severity]));
  card.append(el("p", "text-xs text-neutral-300 leading-relaxed", finding.explanation));

  if (finding.evidence.length) {
    const evidence = el("div", "flex flex-col gap-1 pt-1 border-t border-neutral-700/60");
    evidence.append(el("div", SECTION_LABEL, "Evidence on this page"));
    for (const item of finding.evidence) {
      const row = el("div", "text-[11px] font-mono text-neutral-400 break-all leading-snug", item);
      row.title = item;
      evidence.appendChild(row);
    }
    card.appendChild(evidence);
  }
  return card;
}

function renderAsks(asks: readonly SensitiveAsk[]): HTMLElement {
  const section = el("div", "flex flex-col gap-1.5");
  section.append(el("div", SECTION_LABEL, "What this page asks you for"));
  const seen = new Set<string>();
  for (const ask of asks) {
    const key = `${ask.kind}|${ask.formLabel}|${ask.destination}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = el("div", "text-xs text-neutral-300 leading-snug");
    row.append(
      el("span", "text-neutral-100", ask.label),
      document.createTextNode(` — ${ask.formLabel}, sent to `),
      el("span", "font-mono text-neutral-400 break-all", ask.destination),
    );
    section.appendChild(row);
  }
  section.append(
    el(
      "p",
      "text-[11px] text-neutral-500 leading-snug",
      "Read from the field names and types in the page. Nothing you have typed is read, and the destination is the address written in the markup, not wherever the data travels after that.",
    ),
  );
  return section;
}

export function mountSecurityPanel(container: HTMLElement): void {
  const root = el("div", "p-4 flex flex-col gap-4 text-sm");
  container.appendChild(root);

  const header = el("div", "flex flex-col gap-1.5");
  header.append(el("h1", "text-neutral-100 font-medium", "Security — is this safe?"));
  header.append(
    el(
      "p",
      "text-xs text-neutral-400 leading-relaxed",
      "Reads what the page itself shows: where it is served from, where its forms post, where its links go, and whose code runs on it. Every finding names the evidence it came from. It does not decide whether this page can be trusted — nothing here checks who runs it. Everything is computed on your machine; nothing is sent anywhere, and no value you have typed is read.",
    ),
  );
  root.appendChild(header);

  const toolbar = el("div", "flex items-center gap-2");
  const checkBtn = el("button", BTN, "Check this page");
  toolbar.appendChild(checkBtn);
  root.appendChild(toolbar);

  const status = el("p", "text-xs text-neutral-500 min-h-[1em]", "Nothing checked yet.");
  root.appendChild(status);

  const origin = el("div", "flex flex-col gap-1.5");
  origin.hidden = true;
  root.appendChild(origin);

  const summary = el("p", "text-xs text-neutral-300 leading-relaxed");
  summary.hidden = true;
  root.appendChild(summary);

  const findingsSection = el("div", "flex flex-col gap-2");
  root.appendChild(findingsSection);

  const asksSection = el("div", "flex flex-col gap-1.5 pt-3 border-t border-neutral-800");
  asksSection.hidden = true;
  root.appendChild(asksSection);

  const footer = el("div", "flex flex-col gap-1.5 pt-3 border-t border-neutral-800");
  footer.hidden = true;
  root.appendChild(footer);

  function render(reading: SecurityReading): void {
    origin.replaceChildren();
    const hostRow = el("div", "flex flex-wrap items-center gap-2");
    hostRow.append(el("span", "text-neutral-100 font-mono text-xs break-all", reading.hostname || "(no hostname)"), transportChip(reading));
    const urlRow = el("div", "text-[11px] font-mono text-neutral-500 break-all", reading.url);
    urlRow.title = reading.url;
    origin.append(
      el("div", SECTION_LABEL, "Checked"),
      hostRow,
      urlRow,
      el(
        "div",
        "text-[11px] text-neutral-500",
        `${reading.counts.forms} form${reading.counts.forms === 1 ? "" : "s"} · ${reading.counts.links} link${reading.counts.links === 1 ? "" : "s"} · ${reading.counts.thirdPartyOrigins} third-party code origin${reading.counts.thirdPartyOrigins === 1 ? "" : "s"}`,
      ),
    );
    origin.hidden = false;

    summary.textContent = reading.findings.length ? findingsSummary(reading.findings) : emptyFindingsMessage();
    summary.hidden = false;

    findingsSection.replaceChildren();
    for (const finding of reading.findings) findingsSection.appendChild(renderFinding(finding));

    asksSection.replaceChildren();
    if (reading.asks.length) {
      asksSection.appendChild(renderAsks(reading.asks));
      asksSection.hidden = false;
    } else {
      asksSection.hidden = true;
    }

    footer.replaceChildren(el("div", SECTION_LABEL, "What we could not check"));
    const list = el("ul", "flex flex-col gap-1 list-disc pl-4");
    for (const line of reading.notChecked) list.appendChild(el("li", "text-[11px] text-neutral-500 leading-snug", line));
    footer.appendChild(list);
    footer.hidden = false;
  }

  checkBtn.addEventListener("click", async () => {
    checkBtn.disabled = true;
    status.textContent = "Reading this page…";
    try {
      const tabId = await getActiveTabId();
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: collectSecuritySignals });
      if (!result) {
        status.textContent = "Nothing came back from this page.";
        return;
      }
      render(readSecuritySignals(result));
      status.textContent = `Read at ${new Date().toLocaleTimeString()}. This is a snapshot; the page can change after it.`;
    } catch (err) {
      status.textContent = pageAccessError(err);
    } finally {
      checkBtn.disabled = false;
    }
  });
}
