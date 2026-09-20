import type { RawApplicationSignals, RawControl, RawOverlay, RawPermission, RawResource } from "../lib/application-heuristics";

/**
 * Self-contained, invoked via chrome.scripting.executeScript — see extractPageBlocks in
 * ./functions.ts for the rule: Chrome re-serializes only this function's own source into the
 * page, so every constant and helper below is declared inside the body. Only `import type`
 * survives (it is erased at compile time).
 *
 * It measures and never judges — classification lives in ../lib/application-heuristics.ts where
 * it can be tested. It is async because navigator.permissions.query is; executeScript awaits the
 * promise, and every branch resolves rather than rejecting so a blocked API cannot empty the scan.
 */
export async function collectApplicationSignals(): Promise<RawApplicationSignals> {
  const MAX_FIELDS = 250;
  const MAX_RESOURCES = 300;
  const MAX_CHECKBOXES = 120;
  const MAX_CONTROLS = 400;
  const MAX_TEXT_LINES = 800;
  const MAX_LINE_LENGTH = 200;
  const MAX_COOKIE_NAMES = 10;
  const PERMISSION_NAMES = ["geolocation", "notifications", "camera", "microphone"];
  const TRANSPARENT = /^(transparent|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)|rgba\(\s*0\s+0\s+0\s*\/\s*0\s*\))$/;

  const truncated: string[] = [];

  const text = (value: string | null | undefined, max: number): string => {
    const clean = (value ?? "").replace(/\s+/g, " ").trim();
    return clean.length > max ? clean.slice(0, max) : clean;
  };

  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };

  const labelTextFor = (el: Element): string => {
    const id = el.getAttribute("id");
    if (id) {
      try {
        const labelled = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (labelled) return text(labelled.textContent, 160);
      } catch {
        /* an id that breaks the selector is not worth failing the scan over */
      }
    }
    const wrapping = el.closest("label");
    if (wrapping) return text(wrapping.textContent, 160);
    const described = el.getAttribute("aria-labelledby");
    if (described) {
      const target = document.getElementById(described.split(/\s+/)[0]);
      if (target) return text(target.textContent, 160);
    }
    return "";
  };

  const backgroundBehind = (el: Element): string => {
    let node: Element | null = el;
    let hops = 0;
    while (node && hops < 12) {
      const color = getComputedStyle(node).backgroundColor;
      if (color && !TRANSPARENT.test(color.replace(/\s+/g, " ").trim())) return color;
      node = node.parentElement;
      hops += 1;
    }
    return "rgb(255, 255, 255)";
  };

  const docHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight, 1);
  const positionRatioOf = (el: Element): number => {
    const top = el.getBoundingClientRect().top + window.scrollY;
    return Math.min(1, Math.max(0, top / docHeight));
  };

  // ---- Form fields ----------------------------------------------------------------------------
  const fields: RawApplicationSignals["fields"] = [];
  const checkboxes: RawApplicationSignals["checkboxes"] = [];
  const controlNodes = Array.from(document.querySelectorAll("input, select, textarea"));
  for (const node of controlNodes) {
    const type = (node.getAttribute("type") ?? (node.tagName === "INPUT" ? "text" : "")).toLowerCase();

    if (type === "checkbox") {
      // Not gated on `instanceof HTMLInputElement`: a checkbox from another realm is still a
      // checkbox to the reader, and falling through would file it as a data-collecting field.
      if (checkboxes.length < MAX_CHECKBOXES) {
        checkboxes.push({
          // The `checked` attribute is what "already ticked when you arrived" means in HTML. The
          // live property would also catch boxes script ticked, but so would boxes the reader
          // ticked, and those must never be reported as the page's doing.
          defaultChecked: node.hasAttribute("checked"),
          label: labelTextFor(node),
          name: text(node.getAttribute("name") || node.getAttribute("id"), 80),
        });
      } else if (!truncated.includes("checkboxes")) {
        truncated.push("checkboxes");
      }
      continue;
    }

    // A hidden input collects nothing the reader types, and counting it would inflate the tally.
    if (type === "hidden") continue;
    if (fields.length >= MAX_FIELDS) {
      if (!truncated.includes("form fields")) truncated.push("form fields");
      continue;
    }
    if (!isVisible(node)) continue;

    fields.push({
      tag: node.tagName.toLowerCase(),
      type,
      name: text(node.getAttribute("name"), 80),
      id: text(node.getAttribute("id"), 80),
      autocomplete: text(node.getAttribute("autocomplete"), 60),
      placeholder: text(node.getAttribute("placeholder"), 120),
      ariaLabel: text(node.getAttribute("aria-label"), 120),
      label: labelTextFor(node),
      required: node.hasAttribute("required") || node.getAttribute("aria-required") === "true",
    });
  }

  // ---- Third-party resources ------------------------------------------------------------------
  const resources: RawResource[] = [];
  const pushResource = (kind: RawResource["kind"], url: string): void => {
    if (!url) return;
    if (resources.length >= MAX_RESOURCES) {
      if (!truncated.includes("page resources")) truncated.push("page resources");
      return;
    }
    resources.push({ kind, url });
  };

  for (const script of Array.from(document.querySelectorAll("script[src]"))) {
    pushResource("script", (script as HTMLScriptElement).src);
  }

  for (const frame of Array.from(document.querySelectorAll("iframe[src]"))) {
    pushResource("iframe", (frame as HTMLIFrameElement).src);
  }
  // This collector runs in the top document only, so every frame is unread, same-origin or not.
  const frameCount = document.querySelectorAll("iframe, frame").length;

  // A 1x1 image from another origin is a tracking pixel in all but name.
  for (const image of Array.from(document.querySelectorAll("img[src]"))) {
    const img = image as HTMLImageElement;
    const tiny =
      (img.naturalWidth > 0 && img.naturalWidth <= 2 && img.naturalHeight <= 2) ||
      (img.getAttribute("width") === "1" && img.getAttribute("height") === "1");
    if (tiny) pushResource("pixel", img.src);
  }

  // ---- Clickable controls ---------------------------------------------------------------------
  const controls: RawControl[] = [];
  const clickable = Array.from(
    document.querySelectorAll('a[href], button, [role="button"], input[type="submit"], input[type="button"], summary'),
  );
  for (const node of clickable) {
    if (controls.length >= MAX_CONTROLS) {
      if (!truncated.includes("links and buttons")) truncated.push("links and buttons");
      break;
    }
    const label =
      node instanceof HTMLInputElement ? text(node.value, 200) : text(node.textContent || node.getAttribute("aria-label"), 200);
    if (!label) continue;
    if (!isVisible(node)) continue;
    const style = getComputedStyle(node);
    controls.push({
      text: label,
      kind: node.tagName === "A" ? "link" : "button",
      fontSizePx: parseFloat(style.fontSize) || 0,
      color: style.color,
      background: backgroundBehind(node),
      positionRatio: positionRatioOf(node),
    });
  }

  // ---- Visible text, one short line at a time --------------------------------------------------
  const textLines: string[] = [];
  const seenLines = new Set<string>();
  const body = document.body;
  if (body) {
    for (const raw of (body.innerText ?? "").split("\n")) {
      if (textLines.length >= MAX_TEXT_LINES) {
        if (!truncated.includes("page text")) truncated.push("page text");
        break;
      }
      const line = raw.replace(/\s+/g, " ").trim();
      if (!line || line.length > MAX_LINE_LENGTH || seenLines.has(line)) continue;
      seenLines.add(line);
      textLines.push(line);
    }
  }

  // ---- Overlays covering the page ---------------------------------------------------------------
  const overlays: RawOverlay[] = [];
  const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
  const overlayCandidates = new Set<Element>(
    Array.from(document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')),
  );
  // Whatever is painted over the middle of the window is, by definition, in the reader's way.
  for (const point of [
    [window.innerWidth / 2, window.innerHeight / 2],
    [window.innerWidth / 2, window.innerHeight * 0.85],
  ]) {
    for (const el of document.elementsFromPoint(point[0], point[1])) {
      const style = getComputedStyle(el);
      if (style.position === "fixed" || style.position === "sticky") overlayCandidates.add(el);
    }
  }
  for (const el of overlayCandidates) {
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    const coverage = (visibleWidth * visibleHeight) / viewportArea;
    if (coverage < 0.15) continue;
    const zIndexRaw = parseInt(getComputedStyle(el).zIndex, 10);
    overlays.push({
      coverage: Math.round(coverage * 100) / 100,
      zIndex: Number.isNaN(zIndexRaw) ? 0 : zIndexRaw,
      text: text(el instanceof HTMLElement ? el.innerText : el.textContent, 200),
    });
  }

  const scrollLocked =
    getComputedStyle(document.body).overflow === "hidden" || getComputedStyle(document.documentElement).overflow === "hidden";

  // ---- Storage --------------------------------------------------------------------------------
  let cookieCount = 0;
  let cookieNames: string[] = [];
  let localStorageKeys = 0;
  let sessionStorageKeys = 0;
  let storageNote = "";
  try {
    const cookies = document.cookie ? document.cookie.split(";").map((c) => c.trim()).filter(Boolean) : [];
    cookieCount = cookies.length;
    // Names only — a cookie value can be a session token and has no business leaving the page.
    cookieNames = cookies.slice(0, MAX_COOKIE_NAMES).map((c) => text(c.split("=")[0], 40)).filter(Boolean);
  } catch {
    storageNote = "Cookies could not be read on this page.";
  }
  try {
    localStorageKeys = window.localStorage.length;
    sessionStorageKeys = window.sessionStorage.length;
  } catch {
    storageNote = storageNote
      ? `${storageNote} Browser storage is blocked here too.`
      : "Browser storage could not be read on this page.";
  }

  // ---- Permissions ------------------------------------------------------------------------------
  const permissions: RawPermission[] = [];
  for (const name of PERMISSION_NAMES) {
    if (!navigator.permissions?.query) {
      permissions.push({ name, state: "unsupported" });
      continue;
    }
    try {
      // Names vary by browser; an unknown one throws TypeError rather than resolving.
      const status = await navigator.permissions.query({ name: name as PermissionName });
      const state = status?.state;
      permissions.push({
        name,
        state: state === "granted" || state === "denied" || state === "prompt" ? state : "error",
      });
    } catch (err) {
      permissions.push({ name, state: err instanceof TypeError ? "unsupported" : "error" });
    }
  }

  return {
    url: location.href,
    fields,
    resources,
    checkboxes,
    controls,
    textLines,
    overlays,
    scrollLocked,
    cookieCount,
    cookieNames,
    localStorageKeys,
    sessionStorageKeys,
    storageNote,
    permissions,
    frameCount,
    truncated,
  };
}
