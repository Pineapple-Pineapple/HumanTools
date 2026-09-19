import type { PageModel } from "../lib/types";

const MIN_BLOCK_LENGTH = 40;
const EXCLUDED_ANCESTOR_SELECTOR = "nav, header, footer, aside, script, style";

/**
 * Self-contained: invoked via chrome.scripting.executeScript by reference, so it
 * cannot close over anything from the module scope (Chrome re-serializes the
 * function body into the page's isolated world). Only `import type` is safe here.
 */
export function extractPageBlocks(): PageModel {
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
