import type { FieldSignal, FormSignal, LinkSignal, SecuritySignals } from "../lib/security-heuristics";

/**
 * Self-contained: invoked via chrome.scripting.executeScript by reference, so Chrome re-serializes
 * only this function's own source into the page's isolated world. It cannot close over anything
 * from module scope — not imports, not sibling consts — those would throw ReferenceError at
 * injection time and silently return nothing. Only `import type` is safe (erased at compile time)
 * and literals declared inside the function body itself. See extractPageBlocks in ./functions.ts.
 *
 * It is injected with allFrames: true, so this runs once per frame and returns one of these per
 * frame. Each copy describes its own document only — its own url, origin and hostname — and the
 * side panel keeps them apart so a form inside a payment frame is reported as being in that frame.
 *
 * It reads structure only. No field values are read, ever — not even to classify a field, which
 * happens later from name, type and autocomplete metadata in src/lib/security-heuristics.ts.
 */
export function collectSecuritySignals(): SecuritySignals {
  // A ceiling no real page reaches, kept only so a generated page cannot hang the walk. The checks
  // per link are a few string comparisons, so there is no reason to stop at a few hundred.
  const MAX_LINKS = 20000;
  const MAX_FORMS = 200;
  const MAX_FIELDS = 40;
  const MAX_CODE_SOURCES = 300;
  const MAX_MIXED = 50;
  const MAX_ROOTS = 5000;
  const TEXT_CAP = 120;

  const pageUrl = location.href;
  const pageOrigin = location.origin;

  // Every open shadow root in this document, gathered once. A closed root returns null from
  // element.shadowRoot and is unreachable by design; there is nothing to do about that here.
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

  const queryAll = (selector: string): Element[] => {
    const found: Element[] = [];
    for (const root of roots) {
      for (const el of Array.from(root.querySelectorAll(selector))) found.push(el);
    }
    return found;
  };

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

  // The form a field belongs to, crossing shadow boundaries on the way up. element.form already
  // handles the form="id" attribute but stops at a shadow root, so a field inside a component
  // inside a form would otherwise be reported as belonging to no form at all.
  const ownerForm = (el: Element): HTMLFormElement | null => {
    const own = (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).form;
    if (own) return own;
    let node: Node | null = el.parentNode;
    while (node) {
      if ((node as Element).tagName === "FORM") return node as HTMLFormElement;
      const host = node.nodeType === 11 ? (node as ShadowRoot).host : null;
      node = host ?? node.parentNode;
    }
    return null;
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
  const allForms = queryAll("form") as HTMLFormElement[];
  const fieldsByForm = new Map<Element, Element[]>();
  const orphanFields: Element[] = [];
  for (const el of queryAll("input, select, textarea")) {
    const owner = ownerForm(el);
    if (!owner) {
      orphanFields.push(el);
      continue;
    }
    const existing = fieldsByForm.get(owner);
    if (existing) existing.push(el);
    else fieldsByForm.set(owner, [el]);
  }

  const forms: FormSignal[] = [];
  allForms.slice(0, MAX_FORMS).forEach((form, index) => {
    const actionRaw = form.getAttribute("action");
    // An absent action means the form posts back to the page's own URL, which is what matters
    // for the http and off-site checks, so resolve it that way rather than leaving it blank.
    const action = actionRaw === null ? absolute(pageUrl) : absolute(actionRaw);
    const fieldEls = fieldsByForm.get(form) ?? [];
    const formActions = Array.from(form.querySelectorAll("[formaction]"))
      .map((el) => absolute(el.getAttribute("formaction")))
      .filter((href): href is string => Boolean(href));

    forms.push({
      label: labelForForm(form, index),
      action,
      actionRaw: actionRaw === null ? "" : squash(actionRaw),
      formActions,
      fields: fieldEls.slice(0, MAX_FIELDS).map(readField),
      fieldsTruncated: fieldEls.length > MAX_FIELDS,
    });
  });

  // Inputs that belong to no form at all: nothing in the markup says where their value goes.
  const looseSensitiveFields: FieldSignal[] = [];
  const LOOSE_SELECTOR =
    "input[type=password], input[autocomplete*='cc-'], input[name*='card' i], input[name*='cvv' i], input[name*='cvc' i], input[id*='password' i]";
  for (const el of orphanFields) {
    if (looseSensitiveFields.length >= MAX_FIELDS) break;
    if (el.matches(LOOSE_SELECTOR)) looseSensitiveFields.push(readField(el));
  }

  // ---- Links -----------------------------------------------------------------------------------
  const anchors = queryAll("a[href]");
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
  let codeSourcesTruncated = false;
  for (const el of queryAll("script[src], iframe[src]")) {
    const href = absolute(el.getAttribute("src"));
    if (!href) continue;
    if (codeSources.length >= MAX_CODE_SOURCES) {
      codeSourcesTruncated = true;
      break;
    }
    codeSources.push({ kind: el.tagName.toLowerCase() === "script" ? "script" : "iframe", url: href, origin: originOf(href) });
  }

  const mixedContent: { kind: "script" | "iframe" | "image" | "stylesheet" | "media" | "object"; url: string }[] = [];
  let mixedContentTruncated = false;
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
      for (const el of queryAll(group.selector)) {
        const raw = el.getAttribute(group.attribute);
        if (!raw) continue;
        // Read the declared URL, not the resolved property: the browser may have upgraded or
        // blocked it, and what the page asked for is the thing worth reporting.
        const href = absolute(raw);
        if (!href.startsWith("http://")) continue;
        if (mixedContent.length >= MAX_MIXED) {
          mixedContentTruncated = true;
          break;
        }
        mixedContent.push({ kind: group.kind, url: href });
      }
    }
  }

  // Frames are counted, not opened: the same collector is injected into every frame in the tab, and
  // the panel subtracts the frames that answered from this count to say what was left unread.
  const frameCount = queryAll("iframe, frame").length;

  return {
    url: pageUrl,
    origin: pageOrigin,
    protocol: location.protocol,
    hostname: location.hostname,
    forms,
    formsTruncated: allForms.length > MAX_FORMS,
    looseSensitiveFields,
    links,
    linksTruncated: anchors.length > MAX_LINKS,
    linkCount: anchors.length,
    codeSources,
    codeSourcesTruncated,
    mixedContent,
    mixedContentTruncated,
    frameCount,
  };
}
