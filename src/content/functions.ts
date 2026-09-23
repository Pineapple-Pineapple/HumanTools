import type { InspectTarget, OutlineBlock, OutlineLabel, PageModel } from "../lib/types";

/**
 * Self-contained: invoked via chrome.scripting.executeScript by reference, so
 * Chrome re-serializes only this function's own source into the page's isolated
 * world. It cannot close over anything from module scope — not imports, not
 * sibling consts — those would throw ReferenceError at injection time. Only
 * `import type` is safe (erased at compile time) and literals declared inside
 * the function body itself.
 *
 * Block text is whitespace-collapsed, so a quote verified against it can be found again on the
 * page by the same comparison. `rewrittenIds` names the paragraphs currently carrying a rewrite,
 * so the Accessibility panel's Restore — and its judgement of whether a targeted paragraph's text
 * changed legitimately — reflect the page rather than its memory of it.
 */
export function extractPageBlocks(): PageModel & { rewrittenIds: string[] } {
  const MIN_BLOCK_LENGTH = 40;
  const EXCLUDED_ANCESTOR_SELECTOR = "nav, header, footer, aside, script, style";
  const REWRITTEN_CLASS = "__ht-rewritten";

  const paragraphs = Array.from(document.querySelectorAll("p"));
  const blocks: { id: string; text: string }[] = [];
  const linkMap = new Map<string, string>();
  const pageUrl = location.href.split("#")[0];

  paragraphs.forEach((el, index) => {
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length < MIN_BLOCK_LENGTH) return;
    if (el.closest(EXCLUDED_ANCESTOR_SELECTOR)) return;

    const id = `ht-b${index}`;
    el.setAttribute("data-ht-block-id", id);
    blocks.push({ id, text });

    el.querySelectorAll("a[href]").forEach((a) => {
      const href = (a as HTMLAnchorElement).href;
      const linkText = a.textContent?.trim();
      if (!href || !linkText || href.split("#")[0] === pageUrl) return;
      if (!linkMap.has(href)) linkMap.set(href, linkText);
    });
  });

  const links = Array.from(linkMap, ([href, text]) => ({ href, text }));
  const rewrittenIds = Array.from(document.querySelectorAll(`.${REWRITTEN_CLASS}[data-ht-block-id]`), (el) =>
    el.getAttribute("data-ht-block-id"),
  ).filter((id): id is string => id !== null);
  return { url: location.href, blocks, links, rewrittenIds };
}

/**
 * Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. Replaces each
 * patched paragraph's contents with the rewrite (prose, or a bullet list) and marks it as generated,
 * with the original text on hover.
 *
 * The paragraph's original child nodes — links, emphasis, inline images — are moved into a stash
 * kept in this isolated world, keyed by element, so Restore can put back the markup itself rather
 * than a text-only copy. The isolated world outlives each call but not an extension reload, so the
 * plain text is also kept on the element as the fallback Restore has when the stash is gone.
 * A paragraph rewritten twice keeps the stash from the first time: the rewrite is never the original.
 */
export function applyRewrites(patches: { id: string; text?: string; bullets?: string[] }[]): void {
  const REWRITTEN_CLASS = "__ht-rewritten";
  const STYLE_ID = "__ht-style";
  const w = window as Window & { __htOriginals?: WeakMap<Element, DocumentFragment> };
  const originals = (w.__htOriginals ??= new WeakMap());

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `.${REWRITTEN_CLASS} { outline: 2px dashed #f59e0b; outline-offset: 2px; background: rgba(245,158,11,.08); }`;
    document.head.appendChild(style);
  }

  for (const patch of patches) {
    if (patch.text === undefined && !patch.bullets) continue;
    const el = document.querySelector(`[data-ht-block-id="${patch.id}"]`);
    if (!(el instanceof HTMLElement)) continue;

    // Stash in a dedicated attribute, never in `title` — a paragraph that already had a tooltip
    // would otherwise lose its original text and get that tooltip written into its body on restore.
    if (el.dataset.htOriginal === undefined) {
      el.dataset.htOriginal = el.textContent ?? "";
      el.dataset.htPrevTitle = el.title;
      const stash = document.createDocumentFragment();
      stash.append(...Array.from(el.childNodes));
      originals.set(el, stash);
    }
    el.title = el.dataset.htOriginal;

    if (patch.bullets) {
      const list = document.createElement("ul");
      list.style.margin = "0";
      list.style.paddingLeft = "1.25em";
      for (const bullet of patch.bullets) {
        const li = document.createElement("li");
        li.textContent = bullet;
        // Whitespace between items, as authored HTML has, so textContent doesn't glue the last word
        // of one bullet to the first of the next when the page is re-read for its grade.
        list.append(li, "\n");
      }
      el.replaceChildren(list);
    } else {
      el.textContent = patch.text ?? "";
    }
    el.classList.add(REWRITTEN_CLASS);
  }
}

/**
 * Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. Finds the
 * element (among ones extraction tagged) whose text contains `quote`, scrolls it into view, and
 * flashes it briefly. Returns whether a match was found.
 */
export function scrollToAndHighlight(quote: string): boolean {
  const FLASH_CLASS = "__ht-flash";
  const STYLE_ID = "__ht-flash-style";

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      `.${FLASH_CLASS} { animation: __ht-flash-anim 1.6s ease-out; } ` +
      `@keyframes __ht-flash-anim { 0% { background: rgba(245,158,11,.5); } 100% { background: transparent; } }`;
    document.head.appendChild(style);
  }

  // Quotes are verified against whitespace-collapsed block text (see extractPageBlocks); the page
  // is searched the same way, or a paragraph wrapped across source lines would never match.
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const needle = collapse(quote);
  if (!needle) return false;

  const candidates = document.querySelectorAll("[data-ht-block-id]");
  for (const el of candidates) {
    if (!(el instanceof HTMLElement)) continue;
    if (!collapse(el.textContent ?? "").includes(needle)) continue;

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove(FLASH_CLASS);
    void el.offsetWidth; // force reflow so the animation restarts on repeat clicks
    el.classList.add(FLASH_CLASS);
    setTimeout(() => el.classList.remove(FLASH_CLASS), 1700);
    return true;
  }

  return false;
}

/**
 * Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. Puts every
 * rewritten paragraph back as it was — its stashed markup when this world still holds it, its plain
 * text otherwise (see applyRewrites). Returns how many paragraphs were put back, so the panel can't
 * claim a restore that didn't happen.
 */
export function restoreOriginal(): number {
  const REWRITTEN_CLASS = "__ht-rewritten";
  const STYLE_ID = "__ht-style";
  const w = window as Window & { __htOriginals?: WeakMap<Element, DocumentFragment> };

  let restored = 0;
  document.querySelectorAll(`.${REWRITTEN_CLASS}`).forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    const stash = w.__htOriginals?.get(el);
    const text = el.dataset.htOriginal;
    if (stash) el.replaceChildren(stash);
    else if (text !== undefined) el.textContent = text;
    if (stash || text !== undefined) restored += 1;
    w.__htOriginals?.delete(el);

    const prevTitle = el.dataset.htPrevTitle;
    if (prevTitle) el.title = prevTitle;
    else el.removeAttribute("title");

    delete el.dataset.htOriginal;
    delete el.dataset.htPrevTitle;
    el.classList.remove(REWRITTEN_CLASS);
  });
  document.getElementById(STYLE_ID)?.remove();
  return restored;
}

/**
 * Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. Captures the
 * reader's current selection for the Inspector: the text, its containing block (tagged with
 * `data-ht-inspect-id` so claim markers can be placed there later), the page's publish date, and
 * the outbound links that back it. Same-page footnote links (Wikipedia's "[1]") are followed to
 * the reference they point at, so the citation's real external source is captured instead.
 * Returns null when nothing meaningful is selected.
 */
export function captureInspectTarget(): InspectTarget | null {
  const MIN_CHARS = 20;
  const MAX_CHARS = 4000;
  const MAX_LINKS = 30;
  const BLOCK_SELECTOR = "p, li, blockquote, dd, dt, td, th, figcaption, h1, h2, h3, h4, h5, h6, pre";

  const BADGE_CLASS = "__ht-claim-badge";

  // Claim badges are our own spans living inside the page's text, so their digits land in both
  // Selection.toString() and Element.textContent. Capturing them would put text in the passage
  // that markClaims later strips, leaving every quote unfindable and every badge unlinked.
  const textWithoutBadges = (node: Node): string => {
    const clone = node.cloneNode(true) as Element | DocumentFragment;
    if (clone instanceof Element || clone instanceof DocumentFragment) {
      clone.querySelectorAll?.(`.${BADGE_CLASS}`).forEach((b) => b.remove());
    }
    return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
  };

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const text = textWithoutBadges(selection.getRangeAt(0).cloneContents());
  if (text.length < MIN_CHARS) return null;

  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const commonEl = common instanceof Element ? common : common.parentElement;
  const block = commonEl?.closest(BLOCK_SELECTOR) ?? commonEl;

  let blockId: string | null = null;
  let paragraph = text;
  const scope: Element =
    block instanceof HTMLElement && block !== document.body && block !== document.documentElement ? block : document.body;
  if (scope !== document.body) {
    blockId = scope.getAttribute("data-ht-inspect-id");
    if (!blockId) {
      blockId = `ht-i${Math.random().toString(36).slice(2, 10)}`;
      scope.setAttribute("data-ht-inspect-id", blockId);
    }
    const blockText = textWithoutBadges(scope);
    if (blockText.length >= text.length && blockText.length <= MAX_CHARS * 2) paragraph = blockText;
  }

  const pageUrl = location.href.split("#")[0];
  const links = new Map<string, string>();
  const addLink = (href: string, label: string) => {
    if (links.size >= MAX_LINKS || !/^https?:\/\//i.test(href) || href.split("#")[0] === pageUrl) return;
    if (!links.has(href)) links.set(href, label.replace(/\s+/g, " ").trim().slice(0, 160) || href);
  };

  scope.querySelectorAll("a[href]").forEach((a) => {
    if (!(a instanceof HTMLAnchorElement)) return;
    if (scope === document.body && !range.intersectsNode(a)) return;
    const href = a.href;
    const [base, fragment] = href.split("#");
    if (base === pageUrl && fragment) {
      // A footnote marker: collect the external links in the reference it points to.
      let note: HTMLElement | null = null;
      try {
        note = document.getElementById(decodeURIComponent(fragment));
      } catch {
        note = null;
      }
      if (!note) return;
      const noteText = note.textContent ?? "";
      let taken = 0;
      note.querySelectorAll("a[href]").forEach((ref) => {
        if (taken >= 2 || !(ref instanceof HTMLAnchorElement)) return;
        if (ref.hostname === location.hostname) return;
        addLink(ref.href, noteText);
        taken++;
      });
      return;
    }
    addLink(href, a.textContent ?? "");
  });

  const meta = (selector: string) => document.querySelector(selector)?.getAttribute("content") || undefined;
  let publishedAt =
    meta('meta[property="article:published_time"]') ??
    meta('meta[itemprop="datePublished"]') ??
    meta('meta[name="date"]') ??
    meta('meta[name="pubdate"]') ??
    (document.querySelector("time[datetime]")?.getAttribute("datetime") || undefined);
  if (!publishedAt) {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const json = JSON.parse(script.textContent ?? "");
        const items = Array.isArray(json) ? json : [json, ...(Array.isArray(json?.["@graph"]) ? json["@graph"] : [])];
        const found = items.find((item: { datePublished?: unknown }) => typeof item?.datePublished === "string");
        if (found) {
          publishedAt = found.datePublished;
          break;
        }
      } catch {
        // Malformed JSON-LD — ignore it.
      }
    }
  }

  return {
    text: text.slice(0, MAX_CHARS),
    paragraph: paragraph.slice(0, MAX_CHARS),
    blockId,
    url: location.href,
    title: document.title,
    publishedAt,
    links: Array.from(links, ([href, label]) => ({ href, text: label })),
  };
}

/**
 * Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. Tells the
 * side panel (HT_SELECTION) whether the page holds a selection long enough to inspect — now, and
 * again whenever that changes — so Inspect selection can be disabled instead of failing on click.
 * Installs its listener once per document; calling it again only re-reports the current state.
 */
export function watchSelection(): void {
  const MIN_CHARS = 20; // keep in step with captureInspectTarget
  const w = window as Window & { __htReportSelection?: (force: boolean) => void };

  if (!w.__htReportSelection) {
    let last: boolean | null = null;
    w.__htReportSelection = (force) => {
      const text = (window.getSelection()?.toString() ?? "").replace(/\s+/g, " ").trim();
      const hasSelection = text.length >= MIN_CHARS;
      if (!force && hasSelection === last) return;
      last = hasSelection;
      try {
        chrome.runtime.sendMessage({ type: "HT_SELECTION", hasSelection }).catch(() => {});
      } catch {
        // The extension was reloaded; this orphaned listener has no one left to tell.
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    document.addEventListener("selectionchange", () => {
      clearTimeout(timer);
      timer = setTimeout(() => w.__htReportSelection?.(false), 100);
    });
  }
  w.__htReportSelection(true);
}

/**
 * Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. Maps the
 * reader's selection to the rewritable paragraph containing it, so selecting a few words is a way
 * of pointing at a paragraph rather than a way of rewriting a fragment. Only paragraphs
 * extractPageBlocks has already stamped can be returned, which is exactly the set the rewrite
 * pipeline can patch; a selection spanning several of them resolves to their common one, or to
 * nothing when they have none. Returns null when the selection points at no rewritable paragraph.
 */
export function captureSelectedBlock(): { blockId: string; text: string } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const node = selection.getRangeAt(0).commonAncestorContainer;
  const from = node instanceof Element ? node : node.parentElement;
  const block = from?.closest("p[data-ht-block-id]");
  if (!(block instanceof HTMLElement)) return null;

  const blockId = block.getAttribute("data-ht-block-id");
  if (!blockId) return null;
  return { blockId, text: (block.textContent ?? "").replace(/\s+/g, " ").trim() };
}

/**
 * Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. The
 * crosshair: hovering a block outlines it and (for the Inspector) underlines its claim-bearing
 * sentences via the CSS Highlight API, so the page's DOM is never rewritten; clicking selects the
 * block's text and tells the side panel it was picked. Escape cancels.
 *
 * Two panels arm this — the Inspector over anything worth reading, Accessibility only over the
 * paragraphs it can actually rewrite — so `config.selector` decides what lights up and
 * `config.source` is echoed in every message back. With `config.multi` the crosshair survives a
 * click and keeps picking, for a panel building up a set rather than choosing one thing. The page holds one picker, so arming a second
 * supersedes the first; the superseded panel is told (HT_PICK_CANCELLED under *its* source) rather
 * than left believing its crosshair is still live.
 */
export function startPickMode(config: {
  source: string;
  selector: string;
  underlineClaims: boolean;
  multi?: boolean;
}): void {
  const STYLE_ID = "__ht-pick-style";
  const HOVER_CLASS = "__ht-pick-hover";
  const ROOT_CLASS = "__ht-picking";
  const HIGHLIGHT_NAME = "__ht-claim-cue";
  const BLOCK_SELECTOR = config.selector;
  const SOURCE = config.source;
  const CLAIM_CUE =
    /\d|%|\b(according to|study|survey|report(?:s|ed)?|percent|increase[sd]?|decrease[sd]?|doubled|tripled|million|billion|found that|shows? that|estimated?|first|largest|most|least)\b/i;

  const w = window as unknown as { __htPick?: { stop: (superseded?: boolean) => void } };
  w.__htPick?.stop(true);

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      `.${HOVER_CLASS} { outline: 2px solid #f59e0b !important; outline-offset: 2px !important; } ` +
      `html.${ROOT_CLASS}, html.${ROOT_CLASS} * { cursor: crosshair !important; } ` +
      `::highlight(${HIGHLIGHT_NAME}) { text-decoration: underline dotted #f59e0b; text-decoration-thickness: 2px; }`;
    document.head.appendChild(style);
  }
  document.documentElement.classList.add(ROOT_CLASS);

  let hovered: HTMLElement | null = null;

  function claimRanges(block: HTMLElement): Range[] {
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const data = node.textContent ?? "";
      const sentence = /[^.!?]+[.!?]*/g;
      let m: RegExpExecArray | null;
      while ((m = sentence.exec(data))) {
        if (m[0].trim().length < 12 || !CLAIM_CUE.test(m[0])) continue;
        const r = document.createRange();
        r.setStart(node, m.index);
        r.setEnd(node, m.index + m[0].length);
        ranges.push(r);
      }
    }
    return ranges;
  }

  function setHovered(next: HTMLElement | null): void {
    if (next === hovered) return;
    hovered?.classList.remove(HOVER_CLASS);
    CSS.highlights?.delete(HIGHLIGHT_NAME);
    hovered = next;
    if (!hovered) return;
    hovered.classList.add(HOVER_CLASS);
    if (!config.underlineClaims) return;
    const ranges = claimRanges(hovered);
    if (ranges.length && typeof Highlight !== "undefined") CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));
  }

  function onOver(e: MouseEvent): void {
    const el = e.target instanceof Element ? e.target.closest(BLOCK_SELECTOR) : null;
    const usable = el instanceof HTMLElement && (el.textContent ?? "").trim().length >= 20;
    setHovered(usable ? el : null);
  }

  function onClick(e: MouseEvent): void {
    if (!hovered) return;
    e.preventDefault();
    e.stopPropagation();
    const picked = hovered;
    // A multi picker stays armed so the next click adds to the set; a single picker is done.
    if (!config.multi) {
      stop();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(picked);
      selection?.addRange(range);
    }
    // The block id rides along for Accessibility, which patches by id rather than by selection.
    // The Inspector ignores it and re-reads the selection it was just handed.
    chrome.runtime
      .sendMessage({
        type: "HT_PICKED",
        source: SOURCE,
        blockId: picked.getAttribute("data-ht-block-id"),
        text: (picked.textContent ?? "").replace(/\s+/g, " ").trim(),
      })
      .catch(() => {});
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    stop();
    chrome.runtime.sendMessage({ type: "HT_PICK_CANCELLED", source: SOURCE }).catch(() => {});
  }

  function stop(superseded = false): void {
    // Only a supersede announces itself: an ordinary stop is something the panel already knows
    // about, and telling it would race its own state back to "not picking".
    if (superseded) {
      chrome.runtime.sendMessage({ type: "HT_PICK_CANCELLED", source: SOURCE }).catch(() => {});
    }
    document.removeEventListener("mouseover", onOver, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    setHovered(null);
    document.documentElement.classList.remove(ROOT_CLASS);
    document.getElementById(STYLE_ID)?.remove();
    delete w.__htPick;
  }

  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  w.__htPick = { stop };
}

/**
 * Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. Marks the
 * paragraphs the Accessibility panel is currently aimed at, replacing whatever was marked before;
 * an empty list clears them. Without this a reader building up a set across a long page has no way
 * to see which paragraphs they chose.
 *
 * The mark is an inset rail rather than an outline, so it never reads as the crosshair's hover
 * (a solid outline) or as a finished rewrite (a dashed one) — a targeted paragraph that then gets
 * rewritten wears both at once and they have to stay tellable apart.
 */
export function markTargets(blockIds: string[]): void {
  const TARGET_CLASS = "__ht-target";
  const STYLE_ID = "__ht-target-style";

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      `.${TARGET_CLASS} { box-shadow: inset 3px 0 0 #f59e0b; background: rgba(245,158,11,.06); ` +
      `padding-left: 8px; border-radius: 2px; }`;
    document.head.appendChild(style);
  }

  const wanted = new Set(blockIds);
  document.querySelectorAll(`.${TARGET_CLASS}`).forEach((el) => {
    const id = el.getAttribute("data-ht-block-id");
    if (id === null || !wanted.has(id)) el.classList.remove(TARGET_CLASS);
  });
  for (const id of wanted) {
    document.querySelector(`[data-ht-block-id="${id}"]`)?.classList.add(TARGET_CLASS);
  }
}

/** Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. */
export function stopPickMode(): void {
  (window as unknown as { __htPick?: { stop: (superseded?: boolean) => void } }).__htPick?.stop();
}

/**
 * Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. Marks each
 * claim's quote inside the inspected block: a soft highlight (CSS Highlight API) plus a small
 * numbered badge colored by evidence status. Clicking a badge tells the side panel which claim.
 * Replaces any previous marks. Returns how many claims were found on the page.
 */
export function markClaims(blockId: string | null, claims: { n: number; quote: string; status: string }[]): number {
  const STYLE_ID = "__ht-inspect-style";
  const BADGE_CLASS = "__ht-claim-badge";
  const HIGHLIGHT_NAME = "__ht-claim-quote";
  const COLORS: Record<string, string> = {
    supported: "#22c55e",
    partly_supported: "#f59e0b",
    unverified: "#a3a3a3",
    contradicted: "#ef4444",
  };
  const LABELS: Record<string, string> = {
    supported: "Supported",
    partly_supported: "Partly supported",
    unverified: "Unverified",
    contradicted: "Contradicted",
  };

  document.querySelectorAll(`.${BADGE_CLASS}`).forEach((b) => b.remove());
  CSS.highlights?.delete(HIGHLIGHT_NAME);

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      `.${BADGE_CLASS} { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; ` +
      `height: 16px; padding: 0 4px; margin-left: 2px; border-radius: 999px; background: #171717; ` +
      `border: 1.5px solid var(--ht-c); color: var(--ht-c); font: 700 10px/1 system-ui, sans-serif; ` +
      `vertical-align: super; cursor: pointer; user-select: none; text-decoration: none; } ` +
      `::highlight(${HIGHLIGHT_NAME}) { background-color: rgba(245, 158, 11, 0.22); }`;
    document.head.appendChild(style);
  }

  const root =
    (blockId && document.querySelector(`[data-ht-inspect-id="${CSS.escape(blockId)}"]`)) || document.body;

  // A whitespace-collapsed, lowercased view of the block's text, mapped back to DOM positions.
  const chars: string[] = [];
  const positions: { node: Text; offset: number }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest(`.${BADGE_CLASS}, script, style`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let prevSpace = true;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const data = node.data;
    for (let i = 0; i < data.length; i++) {
      const isSpace = /\s/.test(data[i]);
      if (isSpace && prevSpace) continue;
      chars.push(isSpace ? " " : data[i].toLowerCase());
      positions.push({ node, offset: i });
      prevSpace = isSpace;
    }
  }
  const haystack = chars.join("");

  const found: { n: number; status: string; at: number; start: { node: Text; offset: number }; end: { node: Text; offset: number } }[] = [];
  for (const claim of claims) {
    const needle = claim.quote.replace(/\s+/g, " ").trim().toLowerCase();
    const at = needle ? haystack.indexOf(needle) : -1;
    if (at === -1) continue;
    const last = positions[at + needle.length - 1];
    found.push({ n: claim.n, status: claim.status, at, start: positions[at], end: { node: last.node, offset: last.offset + 1 } });
  }

  // After a reload the stamped id is gone and the whole body was searched. Put the id back on the
  // block holding the first match, so "Show on page" can find it again without re-inspecting.
  if (blockId && root === document.body && found.length) {
    const BLOCKS = "p, li, blockquote, dd, dt, td, th, figcaption, h1, h2, h3, h4, h5, h6, pre";
    found[0].start.node.parentElement?.closest(BLOCKS)?.setAttribute("data-ht-inspect-id", blockId);
  }

  const ranges = found.map((f) => {
    const r = document.createRange();
    r.setStart(f.start.node, f.start.offset);
    r.setEnd(f.end.node, f.end.offset);
    return r;
  });
  if (ranges.length && typeof Highlight !== "undefined") CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges));

  // Insert badges from the last match backward, so splitting a text node never shifts a
  // position that an earlier match still depends on.
  for (const f of [...found].sort((a, b) => b.at - a.at)) {
    const badge = document.createElement("span");
    badge.className = BADGE_CLASS;
    badge.textContent = String(f.n);
    badge.title = `Claim ${f.n} · ${LABELS[f.status] ?? f.status} — click to open it in Human Tools`;
    badge.style.setProperty("--ht-c", COLORS[f.status] ?? "#a3a3a3");
    badge.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "HT_CLAIM_CLICK", n: f.n }).catch(() => {});
    });
    const at = document.createRange();
    at.setStart(f.end.node, f.end.offset);
    at.collapse(true);
    at.insertNode(badge);
  }

  return found.length;
}

/** Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. */
export function clearClaimMarks(): void {
  document.querySelectorAll(".__ht-claim-badge").forEach((b) => b.remove());
  CSS.highlights?.delete("__ht-claim-quote");
  document.getElementById("__ht-inspect-style")?.remove();
}

/**
 * Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. Scrolls the
 * first element matching `selector` into view and flashes it. Returns whether one was found.
 */
export function flashBySelector(selector: string): boolean {
  const FLASH_CLASS = "__ht-flash";
  const STYLE_ID = "__ht-flash-style";

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      `.${FLASH_CLASS} { animation: __ht-flash-anim 1.6s ease-out; } ` +
      `@keyframes __ht-flash-anim { 0% { background: rgba(245,158,11,.5); } 100% { background: transparent; } }`;
    document.head.appendChild(style);
  }

  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove(FLASH_CLASS);
  void el.offsetWidth; // force reflow so the animation restarts on repeat clicks
  el.classList.add(FLASH_CLASS);
  setTimeout(() => el.classList.remove(FLASH_CLASS), 1700);
  return true;
}

/**
 * Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. Builds the
 * Inspector's Outline: the page's visible blocks in order (headings, paragraphs, lists, tables,
 * figures, and whole nav/header/footer/aside containers), each tagged with `data-ht-outline-id`,
 * with a first-pass label from DOM signals alone — nav elements, ad-like ids/classes and iframes
 * are labeled with confidence (`fixed`); site chrome is a guess the model may revise; everything
 * else starts as "supporting" until the model picks out what's important.
 */
export function extractOutline(): { title: string; blocks: OutlineBlock[] } {
  const MAX_BLOCKS = 250;
  const CANDIDATES =
    "h1,h2,h3,h4,h5,h6,p,ul,ol,dl,blockquote,table,figure,pre,iframe,nav,header,footer,aside,form," +
    "[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=search]";
  const NAV_SELECTOR = "nav,[role=navigation],[role=search]";
  const CHROME_SELECTOR = "aside,form,[role=banner],[role=contentinfo],[role=complementary]";
  const AD_RE = /(^|[\s_-])(ads?|advert\w*|sponsor\w*|promo\w*|dfp|adslot|adunit|outbrain|taboola)([\s_-]|$)/i;
  const BOILER_RE = /(cookie|consent|newsletter|subscribe|share|social|related|recommend|comment|breadcrumb|sidebar|signup|paywall|popup|modal|byline)/i;

  const signature = (el: Element) => `${el.id} ${el.getAttribute("class") ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
  const nearbyMatches = (el: Element, re: RegExp, depth: number) => {
    let cur: Element | null = el;
    for (let i = 0; cur && i < depth; i++, cur = cur.parentElement) if (re.test(signature(cur))) return true;
    return false;
  };
  const isSiteChrome = (el: Element) =>
    el.matches(CHROME_SELECTOR) || (el.matches("header,footer") && !el.closest("main,article"));

  document.querySelectorAll("[data-ht-outline-id]").forEach((el) => {
    el.removeAttribute("data-ht-outline-id");
    el.removeAttribute("data-ht-outline-label");
  });

  const taken = new Set<Element>();
  const raw: { el: Element; tag: string; text: string; label: OutlineLabel; fixed: boolean; level: number | null }[] = [];

  for (const el of document.body.querySelectorAll(CANDIDATES)) {
    if (raw.length >= MAX_BLOCKS) break;
    let inside = false;
    for (let anc = el.parentElement; anc; anc = anc.parentElement) {
      if (taken.has(anc)) {
        inside = true;
        break;
      }
    }
    if (inside || el.closest(".__ht-claim-badge")) continue;

    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    const tag = el.tagName.toLowerCase();
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    const level = /^h[1-6]$/.test(tag) ? Number(tag[1]) : null;
    const isNav = el.matches(NAV_SELECTOR);
    const isChrome = isSiteChrome(el);
    const minChars = level !== null ? 2 : 25;
    if (!isNav && !isChrome && !["iframe", "table", "figure"].includes(tag) && text.length < minChars) continue;

    let label: OutlineLabel = "supporting";
    let fixed = false;
    if (tag === "iframe" || nearbyMatches(el, AD_RE, 4)) {
      label = "advertisement";
      fixed = true;
    } else if (isNav) {
      label = "navigation";
      fixed = true;
    } else if (isChrome || nearbyMatches(el, BOILER_RE, 3)) {
      label = "boilerplate";
    }

    taken.add(el);
    raw.push({ el, tag, text: text.slice(0, 300), label, fixed, level });
  }

  const headingLevels = raw.flatMap((r) => (r.level === null ? [] : [r.level]));
  const minLevel = headingLevels.length ? Math.min(...headingLevels) : 1;
  let headingDepth = -1;
  const blocks: OutlineBlock[] = raw.map((r, i) => {
    const id = `ht-o${i}`;
    r.el.setAttribute("data-ht-outline-id", id);
    r.el.setAttribute("data-ht-outline-label", r.label);
    let depth: number;
    if (r.level !== null) {
      depth = r.level - minLevel;
      headingDepth = depth;
    } else {
      depth = headingDepth + 1;
    }
    return { id, tag: r.tag, depth: Math.max(0, depth), text: r.text || `<${r.tag}>`, label: r.label, fixed: r.fixed };
  });

  return { title: document.title, blocks };
}

/**
 * Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. Records the
 * outline labels on their page elements and, when `show` is true, outlines each block on the page
 * by label; `show` false removes those outlines (the attributes are harmless and stay).
 */
export function applyOutlineLabels(labels: { id: string; label: string }[], show: boolean): void {
  const STYLE_ID = "__ht-outline-style";
  for (const { id, label } of labels) {
    document.querySelector(`[data-ht-outline-id="${CSS.escape(id)}"]`)?.setAttribute("data-ht-outline-label", label);
  }

  const existing = document.getElementById(STYLE_ID);
  if (!show) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent =
    `[data-ht-outline-label="important"] { outline: 2px solid #f59e0b !important; outline-offset: 3px !important; } ` +
    `[data-ht-outline-label="supporting"] { outline: 1px dashed rgba(163,163,163,.6) !important; outline-offset: 3px !important; } ` +
    `[data-ht-outline-label="advertisement"] { outline: 2px dashed #ef4444 !important; outline-offset: 3px !important; } ` +
    `[data-ht-outline-label="navigation"] { outline: 1px dotted #60a5fa !important; outline-offset: 3px !important; } ` +
    `[data-ht-outline-label="boilerplate"] { outline: 1px dotted #737373 !important; outline-offset: 3px !important; }`;
  document.head.appendChild(style);
}

/**
 * Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. Finds the
 * form the Security panel read as number `index`, confirms it still posts where the panel said,
 * scrolls to it and outlines it. Nothing is stamped on the page during the scan, so the form is
 * located the same way it was counted: by walking the document and every open shadow root in the
 * same order the collector does.
 *
 * Returns "changed" rather than highlighting when the destination no longer matches. A security
 * panel pointing at the wrong form is worse than one admitting the page moved under it.
 */
export function highlightSecurityForm(index: number, expectedAction: string): "shown" | "changed" | "missing" {
  const FLASH_CLASS = "__ht-form-flash";
  const STYLE_ID = "__ht-form-flash-style";
  const MAX_ROOTS = 5000;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      `.${FLASH_CLASS} { outline: 3px solid #ef4444 !important; outline-offset: 3px; ` +
      `animation: __ht-form-flash-anim 2s ease-out; } ` +
      `@keyframes __ht-form-flash-anim { 0%, 100% { outline-color: #ef4444; } 50% { outline-color: rgba(239,68,68,.2); } }`;
    document.head.appendChild(style);
  }

  const roots: (Document | ShadowRoot)[] = [document];
  for (let i = 0; i < roots.length && roots.length < MAX_ROOTS; i += 1) {
    for (const el of Array.from(roots[i].querySelectorAll("*"))) {
      const shadow = el.shadowRoot;
      if (shadow) {
        roots.push(shadow);
        if (roots.length >= MAX_ROOTS) break;
      }
    }
  }
  const forms: HTMLFormElement[] = [];
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll("form"))) forms.push(el as HTMLFormElement);
  }

  const form = forms[index];
  if (!form) return "missing";

  // Resolved exactly as the collector resolves it: an absent action means the page's own URL.
  const raw = form.getAttribute("action");
  let action = "";
  try {
    const url = new URL(raw === null ? location.href : raw, document.baseURI);
    action = url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    action = "";
  }
  if (action !== expectedAction) return "changed";

  form.scrollIntoView({ behavior: "smooth", block: "center" });
  form.classList.remove(FLASH_CLASS);
  void form.offsetWidth; // force reflow so the outline restarts on repeat clicks
  form.classList.add(FLASH_CLASS);
  setTimeout(() => form.classList.remove(FLASH_CLASS), 2100);
  return "shown";
}
