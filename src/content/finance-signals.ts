import type { FinanceBlock, FinanceTable, RawFinanceSignals } from "../lib/finance-types";

/**
 * Self-contained: invoked via chrome.scripting.executeScript by reference, so Chrome re-serializes
 * only this function's own source into the page's isolated world. It cannot close over anything
 * from module scope — not imports, not sibling consts — those would throw ReferenceError at
 * injection time and silently return nothing. Only `import type` is safe (erased at compile time)
 * and literals declared inside the function body itself. See extractPageBlocks in ./functions.ts.
 *
 * It measures and never judges. Nothing here parses an amount, converts a unit, or does any
 * arithmetic: that is finance-units and finance-validate, off the page and testable. Tables come
 * back as row-and-column arrays rather than text because flattening a financial table is exactly
 * how a figure silently changes which label it belongs to.
 *
 * Each collected element is stamped with `data-ht-fin-id` matching the id returned with it, so the
 * panel can scroll to the source of a figure that lives in a table cell — which the existing
 * `[data-ht-block-id]` highlight path, set on <p> only, can never reach.
 */
export function collectFinanceSignals(): RawFinanceSignals {
  const MAX_TABLES = 12;
  const MAX_TABLE_ROWS = 80;
  const MAX_TABLE_COLS = 24;
  const MAX_CELL_CHARS = 180;
  const MAX_SPAN = 40;
  const MAX_BLOCKS = 120;
  const MAX_BLOCK_CHARS = 1200;
  const MAX_TOTAL_BLOCK_CHARS = 40000;
  const MAX_CANDIDATES = 6000;
  const MAX_SAMPLE_CHARS = 120000;
  const MAX_HINTS = 8;
  const MIN_BLOCK_CHARS = 8;
  const MIN_NUMERIC_CELLS = 3;

  const SYMBOLS = "$€£¥₹₽₩₪₺₦₱฿₫₴";
  const CODES =
    "USD|EUR|GBP|JPY|CNY|RMB|CHF|CAD|AUD|NZD|INR|SEK|NOK|DKK|SGD|HKD|KRW|BRL|MXN|ZAR|RUB|TRY|" +
    "PLN|AED|SAR|ILS|THB|TWD|CZK|HUF|VND|IDR|MYR|PHP|NGN|EGP|CLP|ARS|COP";
  const MAGNITUDES = "million|billion|trillion|thousand|bn|mn|crore|lakh";
  const BLOCK_SELECTOR = "p,li,h1,h2,h3,h4,h5,h6,blockquote,dd,dt,figcaption";
  const EXCLUDED_ANCESTOR_SELECTOR = "nav, aside, script, style, noscript, [role=navigation]";

  // A currency mark or a magnitude word standing next to a number. Prose that merely says the word
  // "revenue" is not collected: a page's worth of unrelated text costs the model's attention and
  // invites nodes for figures the page never printed.
  const MONEY_RE = new RegExp(
    "[" +
      SYMBOLS +
      "]\\s?-?\\(?\\d|\\d\\s?[" +
      SYMBOLS +
      "]|\\b(?:" +
      CODES +
      ")\\s?-?\\(?\\d|\\d\\s?(?:" +
      CODES +
      ")\\b|\\d[\\d.,\\s]{0,12}(?:" +
      MAGNITUDES +
      ")s?\\b",
    "i",
  );
  // Only used to decide whether a table of bare numbers is worth returning at all.
  const MONEY_WORD_RE =
    /\b(revenue|sales|income|profit|loss|losses|cost|costs|expense|expenses|budget|price|pricing|fee|fees|tax|taxes|salary|wages|payroll|cash|debt|margin|spend|spending|funding|ebitda|capex|opex|dividend|earnings|assets|liabilities|equity|total|subtotal|net|gross|payment|payments|refund|shipping|subscription|per share)\b/i;
  const AMOUNT_RE = new RegExp(
    "[" + SYMBOLS + "]|\\(\\s*[\\d,]+(?:\\.\\d+)?\\s*\\)|\\d[\\d,]*\\.\\d|\\d{1,3}(?:,\\d{3})+",
  );
  const DIGIT_RE = /\d/;
  const SCALE_RE = /\bin\s+(?:thousands|millions|billions|trillions|lakhs?|crores?)\b/i;
  const SCALE_COMPACT_RE = new RegExp(
    "\\(\\s*(?:[" +
      SYMBOLS +
      "]\\s*)?(?:in\\s*)?(?:000'?s|000|[" +
      SYMBOLS +
      "]\\s?(?:mm|m|bn|b|k))\\s*(?:omitted)?\\s*\\)",
    "i",
  );

  const squash = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();

  const isRendered = (el: Element): boolean => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    // A zero box is what catches an element inside a collapsed or display:none ancestor, whose own
    // computed display still reads as it was written.
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };

  /**
   * Returns the scale phrase exactly as the page wrote it — "(in millions)", "$ in thousands" —
   * and never interprets it. When the phrase sits inside parentheses the parentheses come with it,
   * because that is the form a reader would recognise back on the page.
   */
  const scaleNoteIn = (text: string): string => {
    const core = SCALE_RE.exec(text);
    if (core) {
      let start = core.index;
      let end = start + core[0].length;
      const open = text.lastIndexOf("(", start);
      const close = text.indexOf(")", end);
      const enclosed = open !== -1 && close !== -1 && start - open <= 40 && text.indexOf(")", open) === close;
      if (enclosed) return text.slice(open, close + 1).trim();
      const lead = new RegExp("(?:US)?[" + SYMBOLS + "]\\s*$|\\b(?:USD|EUR|GBP|amounts?|figures?|dollars?)\\s*$", "i");
      const before = lead.exec(text.slice(Math.max(0, start - 12), start));
      if (before) start -= before[0].length;
      const after = /^\s+of\s+(?:U\.S\.\s+)?[A-Za-z]+/.exec(text.slice(end));
      if (after) end += after[0].length;
      return text.slice(start, end).trim();
    }
    const compact = SCALE_COMPACT_RE.exec(text);
    return compact ? compact[0].trim() : "";
  };

  const sameScale = (a: string, b: string): boolean =>
    a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");

  const nearestHeading = (el: Element): string => {
    for (let node: Element | null = el; node && node.tagName !== "BODY"; node = node.parentElement) {
      for (let prev = node.previousElementSibling; prev; prev = prev.previousElementSibling) {
        if (/^H[1-6]$/.test(prev.tagName)) return squash(prev.textContent);
        const inner = prev.querySelectorAll("h1,h2,h3,h4,h5,h6");
        if (inner.length > 0) return squash(inner[inner.length - 1].textContent);
      }
    }
    return "";
  };

  const precedingText = (el: Element): string => {
    let text = "";
    let prev = el.previousElementSibling;
    for (let i = 0; prev && i < 2; i += 1, prev = prev.previousElementSibling) {
      text = squash(prev.textContent).slice(0, 300) + " " + text;
    }
    return text.trim();
  };

  /**
   * Lays the cells out on a grid rather than per row, so a rowspan from three rows above still
   * holds its column. A misaligned row would attach a figure to the wrong label, which is the worst
   * thing this file could do.
   */
  const buildRows = (table: Element): { rows: string[][]; rowsCut: boolean; colsCut: boolean } => {
    const grid: (string | undefined)[][] = [];
    const trs = Array.from(table.querySelectorAll("tr"));
    const limit = Math.min(trs.length, MAX_TABLE_ROWS);
    let colsCut = false;

    for (let r = 0; r < limit; r += 1) {
      if (!grid[r]) grid[r] = [];
      let c = 0;
      for (const cell of Array.from(trs[r].children)) {
        if (cell.tagName !== "TD" && cell.tagName !== "TH") continue;
        while (grid[r][c] !== undefined) c += 1;
        if (c >= MAX_TABLE_COLS) {
          colsCut = true;
          break;
        }
        const text = squash(cell.textContent).slice(0, MAX_CELL_CHARS);
        const spanOf = (name: string): number => {
          const raw = parseInt(cell.getAttribute(name) ?? "1", 10);
          return Math.min(Math.max(Number.isFinite(raw) ? raw : 1, 1), MAX_SPAN);
        };
        const colspan = spanOf("colspan");
        const rowspan = spanOf("rowspan");
        // A spanning label is repeated into every position it covers, so a header stays above its
        // column and a row label stays beside its row. An amount is the exception: repeating it
        // would print a figure the page states once as though it were stated several times.
        const filler = AMOUNT_RE.test(text) ? "" : text;
        for (let i = 0; i < rowspan; i += 1) {
          if (!grid[r + i]) grid[r + i] = [];
          for (let j = 0; j < colspan && c + j < MAX_TABLE_COLS; j += 1) {
            grid[r + i][c + j] = i === 0 && j === 0 ? text : filler;
          }
        }
        if (c + colspan > MAX_TABLE_COLS) colsCut = true;
        c += colspan;
      }
    }

    const kept = grid.slice(0, MAX_TABLE_ROWS);
    const width = kept.reduce((w, row) => Math.max(w, row.length), 0);
    const rows: string[][] = [];
    for (const row of kept) {
      const filled: string[] = [];
      for (let i = 0; i < width; i += 1) filled.push(row[i] ?? "");
      if (filled.some((cell) => cell !== "")) rows.push(filled);
    }
    return { rows, rowsCut: trs.length > MAX_TABLE_ROWS, colsCut };
  };

  const url = location.href;
  const title = squash(document.title);
  const truncated: string[] = [];
  const blocks: FinanceBlock[] = [];
  const tables: FinanceTable[] = [];

  // Stale stamps from an earlier run would point the panel at elements no longer in this answer.
  document.querySelectorAll("[data-ht-fin-id]").forEach((el) => el.removeAttribute("data-ht-fin-id"));

  // ---- Tables ---------------------------------------------------------------------------------
  const allTables = Array.from(document.querySelectorAll("table"));
  let nested = 0;
  let hiddenTables = 0;
  let cappedTables = false;

  for (const table of allTables) {
    if (tables.length >= MAX_TABLES) {
      cappedTables = true;
      break;
    }
    // A table wrapping another table is a layout wrapper far more often than a financial statement;
    // reading it would restate the inner table's figures inside a meaningless outer grid. The inner
    // one is in this same list and is read on its own.
    if (table.querySelector("table")) {
      nested += 1;
      continue;
    }
    if (table.closest(EXCLUDED_ANCESTOR_SELECTOR)) continue;

    const captionEl = table.querySelector("caption");
    const captionText = squash(captionEl?.textContent);
    const heading = captionText || squash(table.getAttribute("aria-label")) || nearestHeading(table);
    const { rows, rowsCut, colsCut } = buildRows(table);
    if (rows.length === 0) continue;

    // Where a scale is printed, in the order a reader would find it: the caption, then the header
    // rows, then the line immediately above the table, then anywhere else in the table (a footnote
    // under the figures is the last common place).
    const headerText = rows.slice(0, 3).map((row) => row.join(" ")).join(" ");
    const bodyText = rows.map((row) => row.join(" ")).join(" ");
    const candidates = [captionText, squash(table.getAttribute("aria-label")), headerText, precedingText(table), bodyText];
    const found: string[] = [];
    for (const source of candidates) {
      const note = source ? scaleNoteIn(source) : "";
      if (note && !found.some((seen) => sameScale(seen, note))) found.push(note);
    }
    const scaleNote = found[0] ?? "";

    let numeric = 0;
    let currencySeen = MONEY_RE.test(captionText) || scaleNote !== "";
    for (const row of rows) {
      for (const cell of row) {
        if (!DIGIT_RE.test(cell)) continue;
        numeric += 1;
        if (!currencySeen && MONEY_RE.test(cell)) currencySeen = true;
      }
    }
    const plausible =
      (currencySeen && numeric >= 1) || (numeric >= MIN_NUMERIC_CELLS && MONEY_WORD_RE.test(heading + " " + bodyText));
    if (!plausible) continue;

    if (!isRendered(table)) {
      hiddenTables += 1;
      continue;
    }

    const id = "ht-fin-t" + tables.length;
    table.setAttribute("data-ht-fin-id", id);
    tables.push({ id, caption: heading, scaleNote, rows });

    if (rowsCut) truncated.push("Table " + id + " was read down to its first " + MAX_TABLE_ROWS + " rows.");
    if (colsCut) truncated.push("Table " + id + " was read across its first " + MAX_TABLE_COLS + " columns.");
    if (found.length > 1) {
      // The units module is handed one scale, so when a table prints two, the panel has to say so
      // rather than let the closer one quietly stand for the whole grid.
      truncated.push(
        "Table " + id + ' states more than one scale ("' + found[0] + '" and "' + found[1] + '"); the first was used.',
      );
    }
  }

  // Said only when the walk actually stopped early, never when a table was passed over for having
  // no money in it.
  if (cappedTables) truncated.push("Only the first " + MAX_TABLES + " tables with money in them were read.");
  if (nested > 0) {
    truncated.push(
      nested === 1
        ? "1 table that contains another table was skipped; the inner table was read on its own."
        : nested + " tables that contain other tables were skipped; the inner tables were read on their own.",
    );
  }
  if (hiddenTables > 0) {
    truncated.push(
      hiddenTables === 1
        ? "1 table was not read because it is hidden on the page."
        : hiddenTables + " tables were not read because they are hidden on the page.",
    );
  }

  // ---- Prose ----------------------------------------------------------------------------------
  const elements = document.body ? Array.from(document.body.querySelectorAll(BLOCK_SELECTOR)) : [];
  const scanned = Math.min(elements.length, MAX_CANDIDATES);
  let totalChars = 0;
  let shortened = 0;
  let hiddenBlocks = 0;
  let cappedBlocks = false;

  for (let i = 0; i < scanned; i += 1) {
    if (blocks.length >= MAX_BLOCKS || totalChars >= MAX_TOTAL_BLOCK_CHARS) {
      cappedBlocks = true;
      break;
    }
    const el = elements[i];
    const raw = squash(el.textContent);
    if (raw.length < MIN_BLOCK_CHARS || !MONEY_RE.test(raw)) continue;
    // Cells are returned by the table pass with their row and column intact; reading them again as
    // prose would hand the model the same figure twice, stripped of the label that gave it meaning.
    if (el.closest("table") || el.closest(EXCLUDED_ANCESTOR_SELECTOR)) continue;
    // Take the innermost candidate only, so a list item and the paragraph inside it are not both
    // returned with the same sentence.
    if (el.querySelector(BLOCK_SELECTOR)) continue;
    if (!isRendered(el)) {
      hiddenBlocks += 1;
      continue;
    }

    let text = raw;
    if (text.length > MAX_BLOCK_CHARS) {
      // Cut on a sentence end where there is one: a figure quoted out of a half sentence would not
      // match the page and the validator would drop it.
      const cut = text.slice(0, MAX_BLOCK_CHARS);
      const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
      text = stop > MAX_BLOCK_CHARS / 2 ? cut.slice(0, stop + 1) : cut;
      shortened += 1;
    }

    const id = "ht-fin-b" + blocks.length;
    el.setAttribute("data-ht-fin-id", id);
    blocks.push({ id, text });
    totalChars += text.length;
  }

  if (elements.length > scanned) {
    truncated.push("Only the first " + MAX_CANDIDATES + " passages on this page were looked at.");
  }
  if (cappedBlocks) {
    truncated.push("Reading stopped after " + blocks.length + " passages that mention money; the page has more.");
  }
  if (shortened > 0) {
    truncated.push(shortened + (shortened === 1 ? " long passage was" : " long passages were") + " shortened to their first " + MAX_BLOCK_CHARS + " characters.");
  }
  if (hiddenBlocks > 0) {
    truncated.push(
      hiddenBlocks === 1
        ? "1 passage was not read because it is hidden on the page."
        : hiddenBlocks + " passages were not read because they are hidden on the page.",
    );
  }

  // ---- Currency hints -------------------------------------------------------------------------
  // Counted over what was collected rather than the whole page, so a footer's "£" does not outvote
  // the dollars in the statement that was actually read.
  const sample = (
    blocks.map((b) => b.text).join(" ") +
    " " +
    tables.map((t) => t.caption + " " + t.scaleNote + " " + t.rows.map((row) => row.join(" ")).join(" ")).join(" ")
  ).slice(0, MAX_SAMPLE_CHARS);

  const counts = new Map<string, number>();
  for (const char of sample) {
    if (SYMBOLS.indexOf(char) !== -1) counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  const codeMatches = sample.match(new RegExp("\\b(?:" + CODES + ")\\b", "g")) ?? [];
  for (const code of codeMatches) counts.set(code, (counts.get(code) ?? 0) + 1);
  const currencyHints = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_HINTS)
    .map((entry) => entry[0]);

  return { url, title, blocks, tables, currencyHints, truncated };
}
