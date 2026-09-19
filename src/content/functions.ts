import type { PageModel } from "../lib/types";

/**
 * Self-contained: invoked via chrome.scripting.executeScript by reference, so
 * Chrome re-serializes only this function's own source into the page's isolated
 * world. It cannot close over anything from module scope — not imports, not
 * sibling consts — those would throw ReferenceError at injection time. Only
 * `import type` is safe (erased at compile time) and literals declared inside
 * the function body itself.
 */
export function extractPageBlocks(): PageModel {
  const MIN_BLOCK_LENGTH = 40;
  const EXCLUDED_ANCESTOR_SELECTOR = "nav, header, footer, aside, script, style";

  const paragraphs = Array.from(document.querySelectorAll("p"));
  const blocks: { id: string; text: string }[] = [];
  const linkMap = new Map<string, string>();
  const pageUrl = location.href.split("#")[0];

  paragraphs.forEach((el, index) => {
    const text = el.textContent?.trim() ?? "";
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
  return { url: location.href, blocks, links };
}

/** Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. */
export function applyRewrites(patches: { id: string; text: string }[]): void {
  const REWRITTEN_CLASS = "__ht-rewritten";
  const STYLE_ID = "__ht-style";

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `.${REWRITTEN_CLASS} { outline: 2px dashed #f59e0b; outline-offset: 2px; background: rgba(245,158,11,.08); }`;
    document.head.appendChild(style);
  }

  for (const patch of patches) {
    const el = document.querySelector(`[data-ht-block-id="${patch.id}"]`);
    if (!(el instanceof HTMLElement)) continue;
    if (!el.title) el.title = el.textContent ?? "";
    el.textContent = patch.text;
    el.classList.add(REWRITTEN_CLASS);
  }
}

/** Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. */
export function applyBullets(patches: { id: string; bullets: string[] }[]): void {
  const REWRITTEN_CLASS = "__ht-rewritten";
  const STYLE_ID = "__ht-style";

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `.${REWRITTEN_CLASS} { outline: 2px dashed #f59e0b; outline-offset: 2px; background: rgba(245,158,11,.08); }`;
    document.head.appendChild(style);
  }

  for (const patch of patches) {
    const el = document.querySelector(`[data-ht-block-id="${patch.id}"]`);
    if (!(el instanceof HTMLElement)) continue;
    if (!el.title) el.title = el.textContent ?? "";

    const list = document.createElement("ul");
    list.style.margin = "0";
    list.style.paddingLeft = "1.25em";
    for (const bullet of patch.bullets) {
      const li = document.createElement("li");
      li.textContent = bullet;
      list.appendChild(li);
    }
    el.replaceChildren(list);
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

  const needle = quote.trim().toLowerCase();
  if (!needle) return false;

  const candidates = document.querySelectorAll("[data-ht-block-id]");
  for (const el of candidates) {
    if (!(el instanceof HTMLElement)) continue;
    if (!(el.textContent ?? "").toLowerCase().includes(needle)) continue;

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove(FLASH_CLASS);
    void el.offsetWidth; // force reflow so the animation restarts on repeat clicks
    el.classList.add(FLASH_CLASS);
    setTimeout(() => el.classList.remove(FLASH_CLASS), 1700);
    return true;
  }

  return false;
}

/** Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks. */
export function restoreOriginal(): void {
  const REWRITTEN_CLASS = "__ht-rewritten";
  const STYLE_ID = "__ht-style";

  document.querySelectorAll(`.${REWRITTEN_CLASS}`).forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    el.textContent = el.title || el.textContent;
    el.removeAttribute("title");
    el.classList.remove(REWRITTEN_CLASS);
  });
  document.getElementById(STYLE_ID)?.remove();
}
