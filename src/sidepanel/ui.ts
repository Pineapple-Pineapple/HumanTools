/**
 * The side panel's shared DOM helper, error wording, and visual vocabulary.
 *
 * Five panels had each grown their own copy of these — three `el()`s, four `pageAccessError()`s
 * with drifting wording, and the same Tailwind strings pasted per file. One home means a change
 * to a button or a section label lands everywhere, and a reader of any panel sees one vocabulary.
 * This is a token list, not a component library: panels still build their own DOM.
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Turns a scripting failure on a page extensions can't touch into something a reader understands.
 * `verb` is what the panel was trying to do — "inspected", "scanned" — so the sentence reads as
 * that panel's own.
 */
export function pageAccessError(err: unknown, verb = "read"): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\//i.test(message)) {
    return `This page can't be ${verb} — browser pages and extension stores are off-limits to extensions.`;
  }
  return message || "Couldn't read this page.";
}

// Text tiers. `text-muted` is the theme's contrast-safe dim tone (see style.css); never neutral-500.
export const H1 = "text-neutral-100 font-medium";
export const SECTION_LABEL = "text-[11px] uppercase tracking-wide text-muted";
export const BODY = "text-xs text-neutral-300 leading-relaxed";
export const NOTE = "text-[11px] text-muted leading-snug";
export const STATUS = "text-xs text-muted min-h-[1em]";

// Controls.
export const BTN =
  "inline-flex items-center gap-1.5 px-3 py-1.5 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-neutral-800 border border-neutral-600 rounded text-neutral-100";
export const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:hover:bg-amber-600 rounded text-neutral-950 font-medium";
export const SMALL_BTN =
  "self-start inline-flex items-center gap-1.5 px-2 py-1 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 disabled:hover:bg-neutral-800 border border-neutral-600 rounded text-neutral-100 text-xs";
/** A text-only action that reads as a link: "Set API key", "New chat". */
export const LINK_BTN = "self-start text-xs text-amber-500 hover:underline";

// Chips.
export const CHIP = "inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] leading-none";
export const NEUTRAL_CHIP = `${CHIP} bg-neutral-800 text-neutral-300 border-neutral-600`;
export const ATTENTION_CHIP = `${CHIP} bg-amber-950 text-amber-300 border-amber-800`;
