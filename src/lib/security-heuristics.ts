/**
 * Pure reading of local page signals. Nothing here touches the DOM or the network: the injected
 * collector gathers facts, this module turns them into explained risks. Every finding names the
 * concrete evidence it came from, and nothing here ever produces a verdict, a score, or a stamp —
 * the panel's listed risk is false reassurance, so there is deliberately no number to round up to
 * "fine".
 */

import { registrableDomain } from "./public-suffix";
import { describeHostname } from "./punycode";

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
  /** Frames declared in this document, whether or not the collector got inside them. */
  frameCount: number;
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
 * as different sites. Backed by the real Public Suffix List. A hostname that is nothing but a public
 * suffix ("co.uk" on its own) has no registrable name in it, and is compared as itself rather than
 * being silently widened to "uk".
 */
export function effectiveDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || isIpAddressHost(host)) return host;
  return registrableDomain(host) || host;
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

function destinationOf(form: FormSignal, context: Context): string {
  if (!form.action) return form.actionRaw ? `not a web address (${form.actionRaw})` : "unknown";
  const origin = parseOrigin(form.action);
  if (origin && origin === context.origin) return context.frameUrl ? hostLabel(context.host) : "this site";
  return parseHost(form.action) || form.action;
}

/**
 * One document the collector reached: the top page, or one frame inside it. Each carries its own
 * origin, because "posts somewhere else" means somewhere other than the document the form is in —
 * a payment form inside a payment provider's frame is posting home, not off-site.
 */
interface Context {
  signals: SecuritySignals;
  /** "" for the top document; the frame's own address otherwise. */
  frameUrl: string;
  origin: string;
  host: string;
  domain: string;
}

function contextOf(signals: SecuritySignals, isFrame: boolean): Context {
  const host = signals.hostname.toLowerCase();
  return { signals, frameUrl: isFrame ? signals.url : "", origin: signals.origin, host, domain: effectiveDomain(host) };
}

/** Evidence says which document it came from, or a frame's form reads as if the page wrote it. */
function inFrame(context: Context, text: string): string {
  return context.frameUrl ? `${text} — in frame ${context.frameUrl}` : text;
}

function whereForm(context: Context): string {
  return context.frameUrl ? `inside a frame from ${hostLabel(context.host)}` : "on this page";
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

export function readSecuritySignals(signals: SecuritySignals, frames: readonly SecuritySignals[] = []): SecurityReading {
  const findings: Finding[] = [];
  const asks: SensitiveAsk[] = [];
  const pageHost = signals.hostname.toLowerCase();
  const transport = signals.protocol === "https:" ? "https" : signals.protocol === "http:" ? "http" : "other";

  // The top document and every frame the collector got inside, each read against its own origin.
  const contexts: Context[] = [contextOf(signals, false), ...frames.map((frame) => contextOf(frame, true))];

  const formEntries = contexts.flatMap((context) =>
    context.signals.forms.map((form) => ({ context, form, kinds: sensitiveKinds(form) })),
  );
  for (const { context, form, kinds } of formEntries) {
    const formLabel = context.frameUrl ? `${form.label}, in a frame from ${hostLabel(context.host)}` : form.label;
    for (const kind of kinds) {
      asks.push({ kind, label: SENSITIVE_LABELS[kind], formLabel, destination: destinationOf(form, context) });
    }
  }

  const looseEntries = contexts.flatMap((context) =>
    context.signals.looseSensitiveFields.map((field) => ({ context, field, kind: classifyField(field) })),
  );
  const looseKinds: SensitiveKind[] = [];
  for (const entry of looseEntries) {
    if (entry.kind && !looseKinds.includes(entry.kind)) looseKinds.push(entry.kind);
  }
  const pageAsksForSomethingHigh = hasHighSensitivity([...formEntries.flatMap((entry) => entry.kinds), ...looseKinds]);

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
        "Hostnames beginning xn-- are the encoded form of a name written in non-Latin or accented characters. That is entirely normal for much of the world's web, and it is also how a name is built to read like a familiar brand in the address bar. Both forms are below — the name as it is stored, and the name as the address bar draws it. Characters that would otherwise be invisible are shown as their code points.",
      evidence: [describeHostname(pageHost)],
    });
  }

  const mixed = contexts.flatMap((context) => context.signals.mixedContent.map((item) => ({ context, item })));
  if (mixed.length > 0) {
    findings.push({
      kind: "mixed_content",
      severity: "medium",
      // Frames are read too, so this can come from an encrypted frame inside a page that is not
      // itself encrypted. The wording follows whichever is true rather than assuming the page is.
      title:
        transport === "https"
          ? `This encrypted page pulls in ${mixed.length} resource${mixed.length === 1 ? "" : "s"} over plain http`
          : `${mixed.length} resource${mixed.length === 1 ? " is" : "s are"} requested over plain http inside this page`,
      explanation:
        transport === "https"
          ? "The page arrived encrypted but asks the browser for parts of itself over an unencrypted connection. Those parts can be watched or swapped in transit; when one of them is a script, whoever swaps it controls the page. Browsers block most of this, so some of these may never have loaded."
          : "A document on this page arrived encrypted and then asked the browser for parts of itself over an unencrypted connection. Those parts can be watched or swapped in transit; when one of them is a script, whoever swaps it controls the document it runs in. Browsers block most of this, so some of these may never have loaded.",
      evidence: capEvidence(
        mixed.map(({ context, item }) => inFrame(context, `${item.kind}: ${item.url}`)),
        8,
      ),
    });
  }

  // ---- Forms -----------------------------------------------------------------------------------
  for (const { context, form, kinds } of formEntries) {
    const high = hasHighSensitivity(kinds);
    const asksFor = kinds.length ? kinds.map((kind) => SENSITIVE_LABELS[kind].toLowerCase()).join(", ") : "no identified fields";
    const highKinds = kinds.filter((kind) => HIGH_SENSITIVITY.has(kind)).map((kind) => SENSITIVE_LABELS[kind].toLowerCase()).join(" and ");
    const destinations = [form.action, ...form.formActions].filter(Boolean);
    const where = whereForm(context);
    const frameEvidence = context.frameUrl ? [`In frame: ${context.frameUrl}`] : [];

    if (!form.action) {
      findings.push({
        kind: "form_action_not_a_web_address",
        severity: high ? "medium" : "low",
        title: `A form ${where} does not post to a web address`,
        explanation:
          "This form's destination is not an http(s) URL — it is a mail link, a script call, or missing entirely. Where what you type goes is then decided by code on the page, which is not something this panel can read.",
        evidence: [`${form.label} → ${form.actionRaw || "(no action)"}`, `Asks for: ${asksFor}`, ...frameEvidence],
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
          title: high ? `A form ${where} asking for ${highKinds} posts over plain http` : `A form ${where} posts over plain http`,
          explanation: high
            ? "What is typed into this form is sent unencrypted. Anyone on the path — the local network, an ISP, a proxy — can read it as it goes past, and this is the single thing on this page most worth not doing."
            : "What is typed into this form is sent unencrypted and can be read or altered on the way.",
          evidence: [`${form.label} → ${destination}`, `Asks for: ${asksFor}`, ...frameEvidence],
        });
        continue;
      }

      if (origin && context.origin && origin !== context.origin && effectiveDomain(host) !== context.domain) {
        findings.push({
          kind: "form_posts_off_site",
          severity: high ? "high" : "low",
          title: high
            ? `A form ${where} asking for ${highKinds} posts to ${hostLabel(host)}`
            : `A form ${where} posts to ${hostLabel(host)}`,
          explanation: high
            ? `This form submits to ${hostLabel(host)}, which is not ${hostLabel(context.host)}. Payment processors and identity providers legitimately work this way, and so does a login box whose destination has been quietly changed. The name above is the one that receives what you type — worth recognising before typing it. It is also only the first hop: whatever receives the data can pass it on anywhere, and where it finally rests is not written in the page.`
            : `This form submits to ${hostLabel(host)} rather than back to ${hostLabel(context.host)}. Embedded newsletter, search and analytics forms normally do this; it is listed so the destination is visible rather than assumed. That address is the first hop, not necessarily the last — whoever receives the data can forward it somewhere this panel cannot see.`,
          evidence: [`${form.label} → ${destination}`, `Asks for: ${asksFor}`, ...frameEvidence],
        });
      }
    }
  }

  if (looseEntries.length > 0) {
    findings.push({
      kind: "loose_sensitive_fields",
      severity: hasHighSensitivity(looseKinds) ? "medium" : "low",
      title: `${looseEntries.length} sensitive field${looseEntries.length === 1 ? "" : "s"} sit outside any form`,
      explanation:
        "These inputs are not inside a <form>, so there is no destination written in the page at all. Script on the page decides where the value goes when you submit, and that destination cannot be read from the markup. This is ordinary for modern single-page apps and also the shape a credential skimmer takes.",
      evidence: capEvidence(
        looseEntries.map(({ context, field, kind }) => {
          const name = field.name || field.id || field.ariaLabel || field.placeholder || "(unnamed)";
          return inFrame(context, `${name} — ${kind ? SENSITIVE_LABELS[kind].toLowerCase() : "unclassified"}`);
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

  for (const context of contexts) {
    for (const link of context.signals.links) {
      const claimed = hostFromLinkText(link.text);
      if (claimed) {
        const actual = link.hostname.toLowerCase();
        const webLink = link.protocol === "http:" || link.protocol === "https:";
        if (!webLink) {
          mismatches.push(inFrame(context, `“${link.text}” → ${link.href}`));
        } else if (actual && effectiveDomain(claimed) !== effectiveDomain(actual)) {
          mismatches.push(inFrame(context, `“${link.text}” → ${actual}`));
        }
      }
      if (link.hostname && hasPunycodeLabel(link.hostname)) {
        punycodeLinks.add(inFrame(context, describeHostname(link.hostname.toLowerCase())));
      }
      if (link.hostname && isUrlShortener(link.hostname)) shorteners.add(inFrame(context, link.hostname.toLowerCase()));
      if (
        link.target === "_blank" &&
        !/\bnoopener\b|\bnoreferrer\b/i.test(link.rel) &&
        link.hostname &&
        effectiveDomain(link.hostname) !== context.domain
      ) {
        blankNoOpener.push(inFrame(context, link.href));
      }
      const path = link.href.split(/[?#]/)[0].toLowerCase();
      if (EXECUTABLE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
        executables.push(inFrame(context, link.download ? `${link.href} (marked as a download)` : link.href));
      }
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
      title: `${punycodeLinks.size} encoded internationalized hostname${punycodeLinks.size === 1 ? "" : "s"} in links on this page`,
      explanation:
        "Hostnames beginning xn-- are written in non-Latin or accented characters and display differently from how they are stored. That is normal for much of the web, and it is also the standard way to build a name that reads like a brand it is not. Each line below is the stored name followed by what it draws as, with otherwise-invisible characters written out as code points — the comparison is yours to make.",
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
  // Measured against the top page's own origin: code loaded inside a third-party frame is still
  // code running on this page, and the frame it runs in is itself one of these origins.
  const originCounts = new Map<string, { scripts: number; frames: number }>();
  for (const context of contexts) {
    for (const source of context.signals.codeSources) {
      if (!source.origin || source.origin === signals.origin) continue;
      const entry = originCounts.get(source.origin) ?? { scripts: 0, frames: 0 };
      if (source.kind === "script") entry.scripts += 1;
      else entry.frames += 1;
      originCounts.set(source.origin, entry);
    }
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
    notChecked: buildNotChecked(signals, frames),
    counts: {
      forms: formEntries.length,
      links: contexts.reduce((total, context) => total + context.signals.linkCount, 0),
      thirdPartyOrigins: originCounts.size,
    },
  };
}

/**
 * The panel's honesty line. Every line here has to be a limit that still holds after the code was
 * written — a list of things nobody got round to doing is an excuse list, not a disclosure. What is
 * left is assembled rather than hardcoded so it also names the limits of this particular run: a
 * truncated list, a frame that returned nothing, a form aimed at a named window.
 */
export function buildNotChecked(signals: SecuritySignals, frames: readonly SecuritySignals[] = []): string[] {
  const documents = [signals, ...frames];
  const sum = (pick: (one: SecuritySignals) => number): number => documents.reduce((total, one) => total + pick(one), 0);
  const any = (pick: (one: SecuritySignals) => boolean): boolean => documents.some(pick);

  const lines = [
    "What the page does after this snapshot. Script can add a form, change where one posts, or rewrite a link at any moment.",
    "Whether a name that reads like a familiar one belongs to it. Encoded hostnames are decoded and both forms are shown, so the comparison is there to make; nothing here matches a name against a list of brands, because doing that accuses ordinary international sites of imitation.",
  ];

  if (any((one) => one.linksTruncated)) {
    lines.push(`Links past the first ${sum((one) => one.links.length)} read on this page — there were ${sum((one) => one.linkCount)} in total.`);
  }
  if (any((one) => one.formsTruncated)) lines.push(`Forms past the first ${sum((one) => one.forms.length)} read on this page.`);
  if (any((one) => one.codeSourcesTruncated)) lines.push("Script and frame sources past the first 300 in a document on this page.");
  if (any((one) => one.mixedContentTruncated)) lines.push("Plain-http resources past the first 50 found in a document on this page.");

  // Frames are read by injecting into every one of them; the ones that answer are subtracted from
  // the ones the markup declares, and whatever is left over is named rather than assumed empty.
  const unreadFrames = Math.max(0, sum((one) => one.frameCount) - frames.length);
  if (unreadFrames > 0) {
    lines.push(
      `Inside ${unreadFrames} frame${unreadFrames === 1 ? "" : "s"} that returned nothing. Sandboxed frames and frames that had not finished loading cannot be read; only the frame's address was.`,
    );
  }

  // The same limit hit in several documents is one line, not one line per document — the reader
  // needs to know it applies and where, not to scroll past it repeated.
  const reported = new Map<string, string[]>();
  for (const document of documents) {
    for (const line of document.notCollected) {
      const where = document === signals ? "" : document.url;
      reported.set(line, [...(reported.get(line) ?? []), where]);
    }
  }
  for (const [line, places] of reported) {
    const inFrames = places.filter(Boolean);
    if (inFrames.length === 0) lines.push(line);
    else if (inFrames.length === 1 && places.length === 1) lines.push(`${line} (in frame ${inFrames[0]})`);
    else if (inFrames.length === places.length) lines.push(`${line} (in ${inFrames.length} frames on this page)`);
    else lines.push(`${line} (on this page and in ${inFrames.length} frame${inFrames.length === 1 ? "" : "s"} inside it)`);
  }
  return lines;
}
