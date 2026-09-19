import type { FieldSignal, FormSignal, LinkSignal, SecuritySignals } from "../lib/security-heuristics";

/**
 * Self-contained: invoked via chrome.scripting.executeScript by reference, so Chrome re-serializes
 * only this function's own source into the page's isolated world. It cannot close over anything
 * from module scope — not imports, not sibling consts — those would throw ReferenceError at
 * injection time and silently return nothing. Only `import type` is safe (erased at compile time)
 * and literals declared inside the function body itself. See extractPageBlocks in ./functions.ts.
 *
 * It reads structure only. No field values are read, ever — not even to classify a field, which
 * happens later from name, type and autocomplete metadata in src/lib/security-heuristics.ts.
 */
export function collectSecuritySignals(): SecuritySignals {
  const MAX_LINKS = 600;
  const MAX_FORMS = 40;
  const MAX_FIELDS = 40;
  const MAX_CODE_SOURCES = 300;
  const MAX_MIXED = 50;
  const TEXT_CAP = 120;

  const pageUrl = location.href;
  const pageOrigin = location.origin;

  const absolute = (value: string | null): string => {
    if (!value) return "";
    try {
      const url = new URL(value, document.baseURI);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  };

  const anyUrl = (value: string | null): { href: string; hostname: string; protocol: string } => {
    if (!value) return { href: "", hostname: "", protocol: "" };
    try {
      const url = new URL(value, document.baseURI);
      return { href: url.href, hostname: url.hostname, protocol: url.protocol };
    } catch {
      return { href: value, hostname: "", protocol: "" };
    }
  };

  const originOf = (href: string): string => {
    try {
      return new URL(href).origin;
    } catch {
      return "";
    }
  };

  const squash = (value: string | null | undefined): string => {
    const text = (value ?? "").replace(/\s+/g, " ").trim();
    return text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text;
  };

  const attr = (el: Element, name: string): string => squash(el.getAttribute(name));

  const readField = (el: Element): FieldSignal => {
    const tag = el.tagName.toLowerCase();
    const type =
      tag === "input" ? ((el as HTMLInputElement).type || "text").toLowerCase() : tag === "select" ? "select" : "textarea";
    return {
      tag: tag === "select" ? "select" : tag === "textarea" ? "textarea" : "input",
      type,
      name: attr(el, "name"),
      id: attr(el, "id"),
      autocomplete: attr(el, "autocomplete").toLowerCase(),
      placeholder: attr(el, "placeholder"),
      ariaLabel: attr(el, "aria-label"),
    };
  };

  const labelForForm = (form: HTMLFormElement, index: number): string => {
    const submit = form.querySelector("button[type=submit], input[type=submit], button:not([type])");
    const submitText = submit
      ? squash(submit instanceof HTMLInputElement ? submit.value : submit.textContent)
      : "";
    const legend = squash(form.querySelector("legend")?.textContent);
    const named = attr(form, "aria-label") || attr(form, "name") || attr(form, "id");
    const best = submitText || legend || named;
    return best ? `Form “${best}”` : `Form ${index + 1}`;
  };

  // ---- Forms -----------------------------------------------------------------------------------
  const allForms = Array.from(document.querySelectorAll("form"));
  const forms: FormSignal[] = [];
  allForms.slice(0, MAX_FORMS).forEach((form, index) => {
    const actionRaw = form.getAttribute("action");
    // An absent action means the form posts back to the page's own URL, which is what matters
    // for the http and off-site checks, so resolve it that way rather than leaving it blank.
    const action = actionRaw === null ? absolute(pageUrl) : absolute(actionRaw);
    const fieldEls = Array.from(form.querySelectorAll("input, select, textarea"));
    const formActions = Array.from(form.querySelectorAll("[formaction]"))
      .map((el) => absolute(el.getAttribute("formaction")))
      .filter((href): href is string => Boolean(href));

    forms.push({
      label: labelForForm(form, index),
      method: (form.getAttribute("method") || "get").toLowerCase(),
      action,
      actionRaw: actionRaw === null ? "" : squash(actionRaw),
      hasActionAttribute: actionRaw !== null,
      formActions,
      fields: fieldEls.slice(0, MAX_FIELDS).map(readField),
      fieldsTruncated: fieldEls.length > MAX_FIELDS,
    });
  });

  // Inputs that belong to no form at all: nothing in the markup says where their value goes.
  const looseSensitiveFields: FieldSignal[] = [];
  const LOOSE_SELECTOR =
    "input[type=password], input[autocomplete*='cc-'], input[name*='card' i], input[name*='cvv' i], input[name*='cvc' i], input[id*='password' i]";
  for (const el of Array.from(document.querySelectorAll(LOOSE_SELECTOR))) {
    if (el.closest("form")) continue;
    if (looseSensitiveFields.length >= MAX_FIELDS) break;
    looseSensitiveFields.push(readField(el));
  }

  // ---- Links -----------------------------------------------------------------------------------
  const anchors = Array.from(document.querySelectorAll("a[href]"));
  const links: LinkSignal[] = anchors.slice(0, MAX_LINKS).map((a) => {
    const parsed = anyUrl(a.getAttribute("href"));
    return {
      href: parsed.href,
      hostname: parsed.hostname,
      protocol: parsed.protocol,
      text: squash(a.textContent),
      target: attr(a, "target").toLowerCase(),
      rel: attr(a, "rel").toLowerCase(),
      download: a.hasAttribute("download"),
    };
  });

  // ---- Code sources and mixed content ----------------------------------------------------------
  const codeSources: { kind: "script" | "iframe"; url: string; origin: string }[] = [];
  for (const el of Array.from(document.querySelectorAll("script[src], iframe[src]"))) {
    if (codeSources.length >= MAX_CODE_SOURCES) break;
    const href = absolute(el.getAttribute("src"));
    if (!href) continue;
    codeSources.push({ kind: el.tagName.toLowerCase() === "script" ? "script" : "iframe", url: href, origin: originOf(href) });
  }

  const mixedContent: { kind: "script" | "iframe" | "image" | "stylesheet" | "media" | "object"; url: string }[] = [];
  if (location.protocol === "https:") {
    const groups: { selector: string; attribute: string; kind: "script" | "iframe" | "image" | "stylesheet" | "media" | "object" }[] = [
      { selector: "script[src]", attribute: "src", kind: "script" },
      { selector: "iframe[src]", attribute: "src", kind: "iframe" },
      { selector: "img[src]", attribute: "src", kind: "image" },
      { selector: "link[rel~=stylesheet][href]", attribute: "href", kind: "stylesheet" },
      { selector: "video[src], audio[src], source[src], track[src]", attribute: "src", kind: "media" },
      { selector: "embed[src]", attribute: "src", kind: "object" },
      { selector: "object[data]", attribute: "data", kind: "object" },
    ];
    for (const group of groups) {
      for (const el of Array.from(document.querySelectorAll(group.selector))) {
        if (mixedContent.length >= MAX_MIXED) break;
        const raw = el.getAttribute(group.attribute);
        if (!raw) continue;
        // Read the declared URL, not the resolved property: the browser may have upgraded or
        // blocked it, and what the page asked for is the thing worth reporting.
        const href = absolute(raw);
        if (href.startsWith("http://")) mixedContent.push({ kind: group.kind, url: href });
      }
    }
  }

  // ---- What this walker itself could not see ---------------------------------------------------
  const notCollected: string[] = [];
  const frames = Array.from(document.querySelectorAll("iframe"));
  const crossOriginFrames = frames.filter((frame) => {
    const href = absolute(frame.getAttribute("src"));
    return href !== "" && originOf(href) !== pageOrigin;
  }).length;
  if (crossOriginFrames > 0) {
    notCollected.push(
      `The contents of ${crossOriginFrames} frame${crossOriginFrames === 1 ? "" : "s"} from other origins. Forms and links inside them were not read; only the frame's address was.`,
    );
  }
  if (document.querySelector("form[target]")) {
    notCollected.push("Where a form that targets a frame or a named window ends up after it is submitted.");
  }

  return {
    url: pageUrl,
    origin: pageOrigin,
    protocol: location.protocol,
    hostname: location.hostname,
    title: squash(document.title),
    forms,
    formsTruncated: allForms.length > MAX_FORMS,
    looseSensitiveFields,
    links,
    linksTruncated: anchors.length > MAX_LINKS,
    linkCount: anchors.length,
    codeSources,
    codeSourcesTruncated: codeSources.length >= MAX_CODE_SOURCES,
    mixedContent,
    mixedContentTruncated: mixedContent.length >= MAX_MIXED,
    notCollected,
  };
}
