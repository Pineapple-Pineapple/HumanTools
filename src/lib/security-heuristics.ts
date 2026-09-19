/**
 * Pure reading of local page signals. Nothing here touches the DOM or the network: the injected
 * collector gathers facts, this module turns them into explained risks. Every finding names the
 * concrete evidence it came from, and nothing here ever produces a verdict, a score, or a stamp —
 * the panel's listed risk is false reassurance, so there is deliberately no number to round up to
 * "fine".
 */

export interface FieldSignal {
  tag: "input" | "select" | "textarea";
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  placeholder: string;
  ariaLabel: string;
}

export interface FormSignal {
  label: string;
  method: string;
  /** Absolute URL the form posts to, or "" when the action is not a resolvable web address. */
  action: string;
  actionRaw: string;
  hasActionAttribute: boolean;
  /** formaction overrides declared on submit controls; each one is a second destination. */
  formActions: string[];
  fields: FieldSignal[];
  fieldsTruncated: boolean;
}

export interface LinkSignal {
  href: string;
  hostname: string;
  protocol: string;
  text: string;
  target: string;
  rel: string;
  download: boolean;
}

export interface CodeSourceSignal {
  kind: "script" | "iframe";
  url: string;
  origin: string;
}

export interface MixedContentSignal {
  kind: "script" | "iframe" | "image" | "stylesheet" | "media" | "object";
  url: string;
}

export interface SecuritySignals {
  url: string;
  origin: string;
  protocol: string;
  hostname: string;
  title: string;
  forms: FormSignal[];
  formsTruncated: boolean;
  /** Password/payment inputs sitting outside any <form> — their destination lives in script. */
  looseSensitiveFields: FieldSignal[];
  links: LinkSignal[];
  linksTruncated: boolean;
  linkCount: number;
  codeSources: CodeSourceSignal[];
  codeSourcesTruncated: boolean;
  mixedContent: MixedContentSignal[];
  mixedContentTruncated: boolean;
  /** Things the walker itself could not reach, reported verbatim to the reader. */
  notCollected: string[];
}

export type Severity = "high" | "medium" | "low";

export type FindingKind =
  | "page_over_http"
  | "mixed_content"
  | "form_posts_over_http"
  | "form_posts_off_site"
  | "form_action_not_a_web_address"
  | "loose_sensitive_fields"
  | "link_text_mismatch"
  | "punycode_host"
  | "shortened_link"
  | "third_party_code"
  | "blank_target_no_noopener"
  | "executable_download"
  | "ip_address_host";

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  title: string;
  explanation: string;
  /** Concrete, quotable: the form's action URL, the offending hostname, the mismatched text. */
  evidence: string[];
}

export type SensitiveKind =
  | "password"
  | "payment_card"
  | "card_security_code"
  | "government_id"
  | "date_of_birth"
  | "email"
  | "phone"
  | "address";

export interface SensitiveAsk {
  kind: SensitiveKind;
  label: string;
  formLabel: string;
  /** Where that form posts, in the reader's words — "this site", a hostname, or "unknown". */
  destination: string;
}

export interface SecurityReading {
  url: string;
  hostname: string;
  transport: "https" | "http" | "other";
  findings: Finding[];
  asks: SensitiveAsk[];
  notChecked: string[];
  counts: { forms: number; links: number; thirdPartyOrigins: number };
}

const SENSITIVE_LABELS: Record<SensitiveKind, string> = {
  password: "A password",
  payment_card: "A payment card number",
  card_security_code: "A card security code",
  government_id: "A government ID number",
  date_of_birth: "A date of birth",
  email: "An email address",
  phone: "A phone number",
  address: "A postal address",
};

/** Asked-for values whose misuse is immediate rather than merely annoying. */
const HIGH_SENSITIVITY: ReadonlySet<SensitiveKind> = new Set<SensitiveKind>([
  "password",
  "payment_card",
  "card_security_code",
  "government_id",
]);

const URL_SHORTENERS: ReadonlySet<string> = new Set([
  "bit.ly", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "buff.ly", "is.gd", "cutt.ly",
  "rebrand.ly", "shorturl.at", "rb.gy", "t.ly", "s.id", "lnkd.in", "trib.al", "dlvr.it",
  "ift.tt", "tiny.cc", "shorte.st", "adf.ly", "bl.ink", "snip.ly", "youtu.be", "amzn.to",
  "fb.me", "g.co", "qr.ae", "v.gd", "soo.gd", "clck.ru", "u.to", "shrtco.de",
]);

/** Suffixes where the registrable name is three labels deep, not two. Not a public suffix list. */
const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "net.uk", "sch.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "net.nz", "org.nz",
  "com.br", "com.mx", "com.ar", "com.co", "com.pe", "com.ve",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "co.kr", "or.kr",
  "co.za", "org.za", "co.in", "net.in", "org.in", "gov.in", "ac.in",
  "com.sg", "com.my", "com.hk", "com.tw", "com.cn", "net.cn", "org.cn", "gov.cn",
  "com.tr", "com.ua", "com.pl", "co.il", "com.eg", "com.sa", "com.ng", "co.th", "com.ph", "com.vn",
]);

/**
 * Last labels that make a piece of anchor text read as a web address. Deliberately a list rather
 * than "anything after a dot": without it, "Vue.js" or "index.php" read as hostnames and every
 * link that mentions one becomes a false accusation of disguise.
 */
const COMMON_TLDS: ReadonlySet<string> = new Set([
  "com", "org", "net", "edu", "gov", "mil", "int", "info", "biz", "io", "co", "ai", "app", "dev",
  "me", "tv", "cc", "xyz", "top", "site", "online", "shop", "store", "live", "news", "blog",
  "cloud", "link", "click", "zip", "mov", "uk", "de", "fr", "es", "it", "nl", "se", "no", "dk",
  "fi", "pl", "ru", "ua", "cn", "jp", "kr", "in", "br", "mx", "ar", "au", "nz", "ca", "us", "ch",
  "at", "be", "cz", "gr", "pt", "ro", "hu", "ie", "il", "tr", "za", "sg", "hk", "tw", "th", "vn",
  "id", "ph", "my", "eu", "asia",
]);

const EXECUTABLE_EXTENSIONS = [
  ".exe", ".msi", ".dmg", ".pkg", ".apk", ".bat", ".cmd", ".scr", ".jar", ".vbs", ".ps1", ".sh", ".deb", ".rpm",
];

/** The reader-facing name for a host, with an empty or odd one made obvious rather than blank. */
function hostLabel(hostname: string): string {
  return hostname || "(no hostname)";
}

export function isIpAddressHost(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || (hostname.startsWith("[") && hostname.endsWith("]"));
}

export function hasPunycodeLabel(hostname: string): boolean {
  return hostname
    .toLowerCase()
    .split(".")
    .some((label) => label.startsWith("xn--"));
}

/**
 * The registrable part of a hostname, so "news.example.co.uk" and "example.co.uk" are not reported
 * as different sites. Backed by a short suffix list, which is why the panel says so in
 * "what we could not check".
 */
export function effectiveDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || isIpAddressHost(host)) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  if (MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join("."))) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

export function isUrlShortener(hostname: string): boolean {
  return URL_SHORTENERS.has(hostname.toLowerCase().replace(/^www\./, ""));
}

/**
 * The hostname a piece of visible link text claims to be, or null when the text is just words.
 * Used only to compare against where the link actually goes.
 */
export function hostFromLinkText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 120 || /\s/.test(trimmed)) return null;
  const match = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+)(?::\d+)?(?:[/?#].*)?$/i.exec(trimmed);
  if (!match) return null;
  const host = match[1].toLowerCase();
  const labels = host.split(".");
  const tld = labels[labels.length - 1];
  const explicitScheme = /^https?:\/\//i.test(trimmed) || /^www\./i.test(trimmed);
  if (!explicitScheme && !COMMON_TLDS.has(tld)) return null;
  if (!/^[a-z]{2,}$/.test(tld)) return null;
  return host;
}

export function classifyField(field: FieldSignal): SensitiveKind | null {
  const type = field.type.toLowerCase();
  const autocomplete = field.autocomplete.toLowerCase();
  const words = `${field.name} ${field.id} ${field.placeholder} ${field.ariaLabel}`.toLowerCase();

  if (type === "password") return "password";
  if (autocomplete.includes("cc-csc") || /\b(cvv|cvc|csc)\b|security.?code|card.?code/.test(words)) {
    return "card_security_code";
  }
  if (
    autocomplete.includes("cc-number") ||
    autocomplete.includes("cc-exp") ||
    /card.?number|cardnum|ccnum|cc.?num|credit.?card|debit.?card|pan\b/.test(words)
  ) {
    return "payment_card";
  }
  if (/\bssn\b|social.?security|national.?id|passport|\bnino\b|\bsin\b|tax.?id|driver.?s?.?licen[sc]e/.test(words)) {
    return "government_id";
  }
  if (autocomplete.includes("bday") || /date.?of.?birth|\bdob\b|birth.?date/.test(words)) return "date_of_birth";
  if (type === "email" || autocomplete.includes("email") || /e-?mail/.test(words)) return "email";
  if (type === "tel" || autocomplete.includes("tel") || /\bphone\b|mobile.?number/.test(words)) return "phone";
  if (/street.?address|postal.?code|\bzip\b|address.?line/.test(words) || autocomplete.includes("street-address")) {
    return "address";
  }
  return null;
}

function sensitiveKinds(form: FormSignal): SensitiveKind[] {
  const kinds: SensitiveKind[] = [];
  for (const field of form.fields) {
    const kind = classifyField(field);
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

function hasHighSensitivity(kinds: readonly SensitiveKind[]): boolean {
  return kinds.some((kind) => HIGH_SENSITIVITY.has(kind));
}

function parseHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function parseOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function parseProtocol(url: string): string {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}

/** Keeps evidence lists readable without hiding that there was more of it. */
function capEvidence(items: string[], limit: number): string[] {
  if (items.length <= limit) return items;
  return [...items.slice(0, limit), `…and ${items.length - limit} more`];
}

function destinationOf(form: FormSignal, pageOrigin: string): string {
  if (!form.action) return form.actionRaw ? `not a web address (${form.actionRaw})` : "unknown";
  const origin = parseOrigin(form.action);
  if (origin && origin === pageOrigin) return "this site";
  return parseHost(form.action) || form.action;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/**
 * The line shown when nothing matched. It must not read as a clean bill of health: "we found
 * nothing" and "this page is fine" are different statements, and only the first one is true.
 */
export function emptyFindingsMessage(): string {
  return "None of the checks below matched anything in this page's markup. That is not a judgement about this page — it only means these particular signals were absent. Read what we could not check.";
}

/** A neutral count, never a grade. Severity is per finding; nothing is summed into a verdict. */
export function findingsSummary(findings: readonly Finding[]): string {
  if (findings.length === 0) return "0 things to explain.";
  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const parts = (["high", "medium", "low"] as const)
    .filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${severity}`);
  const noun = findings.length === 1 ? "thing" : "things";
  return `${findings.length} ${noun} to explain (${parts.join(", ")}).`;
}

export function readSecuritySignals(signals: SecuritySignals): SecurityReading {
  const findings: Finding[] = [];
  const asks: SensitiveAsk[] = [];
  const pageHost = signals.hostname.toLowerCase();
  const pageDomain = effectiveDomain(pageHost);
  const transport = signals.protocol === "https:" ? "https" : signals.protocol === "http:" ? "http" : "other";

  const formKinds = signals.forms.map((form) => ({ form, kinds: sensitiveKinds(form) }));
  for (const { form, kinds } of formKinds) {
    for (const kind of kinds) {
      asks.push({ kind, label: SENSITIVE_LABELS[kind], formLabel: form.label, destination: destinationOf(form, signals.origin) });
    }
  }
  const looseKinds: SensitiveKind[] = [];
  for (const field of signals.looseSensitiveFields) {
    const kind = classifyField(field);
    if (kind && !looseKinds.includes(kind)) looseKinds.push(kind);
  }
  const pageAsksForSomethingHigh = hasHighSensitivity([...formKinds.flatMap((entry) => entry.kinds), ...looseKinds]);

  // ---- Transport -------------------------------------------------------------------------------
  if (transport === "http") {
    findings.push({
      kind: "page_over_http",
      severity: pageAsksForSomethingHigh ? "high" : "medium",
      title: "This page travelled over plain http",
      explanation: pageAsksForSomethingHigh
        ? "The page is not encrypted in transit, and it contains fields asking for a password or payment details. Anything typed here can be read, and the page itself can be altered, by anyone between this browser and the server — a network operator, a proxy, or whoever runs the wifi."
        : "The page is not encrypted in transit. Anyone between this browser and the server can read what is sent and can change what arrives, including inserting content the site never wrote.",
      evidence: [signals.url],
    });
  }

  if (isIpAddressHost(pageHost)) {
    findings.push({
      kind: "ip_address_host",
      severity: "medium",
      title: "This page is served from a bare IP address",
      explanation:
        "There is no domain name here, so there is nothing to recognise and nothing a certificate can be issued against in the usual way. Ordinary sites are reached by name; a raw address is common for local development and for hosts that would rather not be named.",
      evidence: [hostLabel(pageHost)],
    });
  }

  if (hasPunycodeLabel(pageHost)) {
    findings.push({
      kind: "punycode_host",
      severity: "medium",
      title: "This page's hostname is an encoded internationalized name",
      explanation:
        "Hostnames beginning xn-- are the encoded form of a name written in non-Latin or accented characters. That is entirely normal for many of the world's sites, and it is also how a name is made to look like a familiar brand in the address bar. What it renders as is not shown here.",
      evidence: [hostLabel(pageHost)],
    });
  }

  if (signals.mixedContent.length > 0) {
    findings.push({
      kind: "mixed_content",
      severity: "medium",
      title: `This encrypted page pulls in ${signals.mixedContent.length} resource${signals.mixedContent.length === 1 ? "" : "s"} over plain http`,
      explanation:
        "The page arrived encrypted but asks the browser for parts of itself over an unencrypted connection. Those parts can be watched or swapped in transit; when one of them is a script, whoever swaps it controls the page. Browsers block most of this, so some of these may never have loaded.",
      evidence: capEvidence(
        signals.mixedContent.map((item) => `${item.kind}: ${item.url}`),
        8,
      ),
    });
  }

  // ---- Forms -----------------------------------------------------------------------------------
  for (const { form, kinds } of formKinds) {
    const high = hasHighSensitivity(kinds);
    const asksFor = kinds.length ? kinds.map((kind) => SENSITIVE_LABELS[kind].toLowerCase()).join(", ") : "no identified fields";
    const destinations = [form.action, ...form.formActions].filter(Boolean);

    if (!form.action) {
      findings.push({
        kind: "form_action_not_a_web_address",
        severity: high ? "medium" : "low",
        title: `A form on this page does not post to a web address`,
        explanation:
          "This form's destination is not an http(s) URL — it is a mail link, a script call, or missing entirely. Where what you type goes is then decided by code on the page, which is not something this panel can read.",
        evidence: [`${form.label} → ${form.actionRaw || "(no action)"}`, `Asks for: ${asksFor}`],
      });
    }

    for (const destination of destinations) {
      const protocol = parseProtocol(destination);
      const host = parseHost(destination);
      const origin = parseOrigin(destination);

      if (protocol === "http:") {
        findings.push({
          kind: "form_posts_over_http",
          severity: high ? "high" : "medium",
          title: high
            ? `A form asking for ${kinds.filter((kind) => HIGH_SENSITIVITY.has(kind)).map((kind) => SENSITIVE_LABELS[kind].toLowerCase()).join(" and ")} posts over plain http`
            : "A form on this page posts over plain http",
          explanation: high
            ? "What is typed into this form is sent unencrypted. Anyone on the path — the local network, an ISP, a proxy — can read it as it goes past, and this is the single thing on this page most worth not doing."
            : "What is typed into this form is sent unencrypted and can be read or altered on the way.",
          evidence: [`${form.label} → ${destination}`, `Asks for: ${asksFor}`],
        });
        continue;
      }

      if (origin && signals.origin && origin !== signals.origin && effectiveDomain(host) !== pageDomain) {
        findings.push({
          kind: "form_posts_off_site",
          severity: high ? "high" : "low",
          title: high
            ? `A form asking for ${kinds.filter((kind) => HIGH_SENSITIVITY.has(kind)).map((kind) => SENSITIVE_LABELS[kind].toLowerCase()).join(" and ")} posts to ${hostLabel(host)}`
            : `A form on this page posts to ${hostLabel(host)}`,
          explanation: high
            ? `This form submits to ${hostLabel(host)}, which is not ${hostLabel(pageHost)}. Payment processors and identity providers legitimately work this way, and so does a login box whose destination has been quietly changed. The name above is the one that receives what you type — it is worth recognising before typing it.`
            : `This form submits to ${hostLabel(host)} rather than back to ${hostLabel(pageHost)}. Embedded newsletter, search and analytics forms normally do this; it is listed so the destination is visible rather than assumed.`,
          evidence: [`${form.label} → ${destination}`, `Asks for: ${asksFor}`],
        });
      }
    }
  }

  if (signals.looseSensitiveFields.length > 0) {
    findings.push({
      kind: "loose_sensitive_fields",
      severity: hasHighSensitivity(looseKinds) ? "medium" : "low",
      title: `${signals.looseSensitiveFields.length} sensitive field${signals.looseSensitiveFields.length === 1 ? "" : "s"} sit outside any form`,
      explanation:
        "These inputs are not inside a <form>, so there is no destination written in the page at all. Script on the page decides where the value goes when you submit, and that destination cannot be read from the markup. This is ordinary for modern single-page apps and also the shape a credential skimmer takes.",
      evidence: capEvidence(
        signals.looseSensitiveFields.map((field) => {
          const kind = classifyField(field);
          const name = field.name || field.id || field.ariaLabel || field.placeholder || "(unnamed)";
          return `${name} — ${kind ? SENSITIVE_LABELS[kind].toLowerCase() : "unclassified"}`;
        }),
        6,
      ),
    });
  }

  // ---- Links -----------------------------------------------------------------------------------
  const mismatches: string[] = [];
  const punycodeLinks = new Set<string>();
  const shorteners = new Set<string>();
  const blankNoOpener: string[] = [];
  const executables: string[] = [];

  for (const link of signals.links) {
    const claimed = hostFromLinkText(link.text);
    if (claimed) {
      const actual = link.hostname.toLowerCase();
      const webLink = link.protocol === "http:" || link.protocol === "https:";
      if (!webLink) {
        mismatches.push(`“${link.text}” → ${link.href}`);
      } else if (actual && effectiveDomain(claimed) !== effectiveDomain(actual)) {
        mismatches.push(`“${link.text}” → ${actual}`);
      }
    }
    if (link.hostname && hasPunycodeLabel(link.hostname)) punycodeLinks.add(link.hostname.toLowerCase());
    if (link.hostname && isUrlShortener(link.hostname)) shorteners.add(link.hostname.toLowerCase());
    if (
      link.target === "_blank" &&
      !/\bnoopener\b|\bnoreferrer\b/i.test(link.rel) &&
      link.hostname &&
      effectiveDomain(link.hostname) !== pageDomain
    ) {
      blankNoOpener.push(link.href);
    }
    const path = link.href.split(/[?#]/)[0].toLowerCase();
    if (EXECUTABLE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
      executables.push(link.download ? `${link.href} (marked as a download)` : link.href);
    }
  }

  if (mismatches.length > 0) {
    findings.push({
      kind: "link_text_mismatch",
      severity: "high",
      title: `${mismatches.length} link${mismatches.length === 1 ? " shows" : "s show"} one address and point${mismatches.length === 1 ? "s" : ""} at another`,
      explanation:
        "The words in the link read as a web address, but the link goes somewhere with a different registered name. Tracking redirectors and link wrappers produce this honestly; so does a link written to look like it goes to a bank. The pairs below are what the page says versus where it goes.",
      evidence: capEvidence(mismatches, 8),
    });
  }

  if (punycodeLinks.size > 0) {
    findings.push({
      kind: "punycode_host",
      severity: "medium",
      title: `${punycodeLinks.size} link${punycodeLinks.size === 1 ? " points" : "s point"} at encoded internationalized hostnames`,
      explanation:
        "Hostnames beginning xn-- are written in non-Latin or accented characters and display differently from how they are stored. That is normal for much of the web, and it is also the standard way to build a name that reads like a brand it is not.",
      evidence: capEvidence([...punycodeLinks], 8),
    });
  }

  if (shorteners.size > 0) {
    findings.push({
      kind: "shortened_link",
      severity: "low",
      title: `${shorteners.size} shortening service${shorteners.size === 1 ? "" : "s"} used in links on this page`,
      explanation:
        "A shortened link does not say where it ends up until it is opened. That is a convenience on social posts and a way to hide a destination everywhere else. Nothing was followed to find out where these go.",
      evidence: capEvidence([...shorteners], 8),
    });
  }

  if (executables.length > 0) {
    findings.push({
      kind: "executable_download",
      severity: "medium",
      title: `${executables.length} link${executables.length === 1 ? " points" : "s point"} at a file that runs when opened`,
      explanation:
        "Installers and scripts do whatever their author wrote, with the permissions of whoever runs them. Where the file comes from matters more than what the page says it is — the addresses are below.",
      evidence: capEvidence(executables, 6),
    });
  }

  // ---- Third-party code ------------------------------------------------------------------------
  const originCounts = new Map<string, { scripts: number; frames: number }>();
  for (const source of signals.codeSources) {
    if (!source.origin || source.origin === signals.origin) continue;
    const entry = originCounts.get(source.origin) ?? { scripts: 0, frames: 0 };
    if (source.kind === "script") entry.scripts += 1;
    else entry.frames += 1;
    originCounts.set(source.origin, entry);
  }
  if (originCounts.size > 0) {
    const listed = [...originCounts.entries()]
      .sort((a, b) => b[1].scripts + b[1].frames - (a[1].scripts + a[1].frames))
      .map(([origin, entry]) => {
        const parts: string[] = [];
        if (entry.scripts) parts.push(`${entry.scripts} script${entry.scripts === 1 ? "" : "s"}`);
        if (entry.frames) parts.push(`${entry.frames} frame${entry.frames === 1 ? "" : "s"}`);
        return `${origin} — ${parts.join(", ")}`;
      });
    findings.push({
      kind: "third_party_code",
      severity: originCounts.size >= 10 ? "medium" : "low",
      title: `Code on this page comes from ${originCounts.size} other origin${originCounts.size === 1 ? "" : "s"}`,
      explanation:
        "Each of these serves script or an embedded frame that runs with the page. Every one of them can read what is on the page and change it, so the page is only as careful as the least careful name on this list. Ads, analytics, fonts and embedded video all land here; the count is a measure of surface, not of intent.",
      evidence: capEvidence(listed, 12),
    });
  }

  if (blankNoOpener.length > 0) {
    findings.push({
      kind: "blank_target_no_noopener",
      severity: "low",
      title: `${blankNoOpener.length} link${blankNoOpener.length === 1 ? " opens" : "s open"} a new tab without rel="noopener"`,
      explanation:
        "A link opening a new tab without this attribute hands the opened page a reference back to this one, which it can use to navigate this tab elsewhere. Current Chrome applies noopener by default, so this is mostly a sign of how carefully the page was written rather than a live hole.",
      evidence: capEvidence(blankNoOpener, 5),
    });
  }

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return {
    url: signals.url,
    hostname: pageHost,
    transport,
    findings,
    asks,
    notChecked: buildNotChecked(signals),
    counts: { forms: signals.forms.length, links: signals.linkCount, thirdPartyOrigins: originCounts.size },
  };
}

/**
 * The panel's honesty line, assembled rather than hardcoded so it also names the limits that only
 * applied to this particular run (a truncated link list, frames that could not be opened).
 */
export function buildNotChecked(signals: SecuritySignals): string[] {
  const lines = [
    "Who owns this domain, how old it is, or whether anyone has reported it. None of that is in the page, and nothing was asked of any service.",
    "Whether the certificate belongs to who you expect. The browser's own padlock is the only certificate check that happened.",
    "What the page does after this snapshot. Script can add a form, change where one posts, or rewrite a link at any moment.",
    "Where your data actually ends up. A form's action is the first hop, not the destination.",
    "Where a link really lands. Destinations were read out of the markup; nothing was opened or followed, and no redirect was resolved.",
    "Anything inside cross-origin frames, closed shadow roots, images, or canvas.",
    "Whether a hostname that reads like a familiar name belongs to it. There is no brand list, no lookalike matching, and encoded names are not decoded.",
    "Which parts of a multi-label domain are registrable. That uses a short built-in suffix list, so an unusual country domain may be compared imprecisely.",
  ];
  if (signals.linksTruncated) lines.push(`Links past the first ${signals.links.length} on this page — there were ${signals.linkCount} in total.`);
  if (signals.formsTruncated) lines.push(`Forms past the first ${signals.forms.length} on this page.`);
  if (signals.codeSourcesTruncated) lines.push("Script and frame sources past the first 300 on this page.");
  if (signals.mixedContentTruncated) lines.push("Plain-http resources past the first 50 found.");
  lines.push(...signals.notCollected);
  return lines;
}
