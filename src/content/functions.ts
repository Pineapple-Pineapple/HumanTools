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

  paragraphs.forEach((el, index) => {
    const text = el.textContent?.trim() ?? "";
    if (text.length < MIN_BLOCK_LENGTH) return;
    if (el.closest(EXCLUDED_ANCESTOR_SELECTOR)) return;

    const id = `ht-b${index}`;
    el.setAttribute("data-ht-block-id", id);
    blocks.push({ id, text });
  });

  return { url: location.href, blocks };
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
