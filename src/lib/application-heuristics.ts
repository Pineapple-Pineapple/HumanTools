/**
 * Turns the raw DOM signals collected by `collectApplicationSignals` into findings a reader can
 * check. Everything here is pure so it can be tested; the collector only measures, it never judges.
 *
 * Two kinds of claim are made, and they are labelled differently in the UI:
 * `observed` — a fact read straight off the page (this input exists, this box is pre-ticked).
 * `pattern`  — a guess from matching words or domain names against a list kept in this file. The
 *              lists are short and hand-written, so a `pattern` finding is never proof and the
 *              absence of one is never an all-clear.
 */

import { limit, type Limit } from "./limits";

// ---- Raw signal shapes (the contract with src/content/application-signals.ts) -----------------

export interface RawFormField {
  tag: string;
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  placeholder: string;
  ariaLabel: string;
  label: string;
  required: boolean;
}

export interface RawResource {
  kind: "script" | "iframe" | "pixel";
  url: string;
}

export interface RawCheckbox {
  /** The `checked` attribute as the page authored it — what was pre-selected before anyone clicked. */
  defaultChecked: boolean;
  checked: boolean;
  label: string;
  name: string;
}

export interface RawControl {
  text: string;
  kind: "link" | "button";
  fontSizePx: number;
  /** Computed colours, as the browser serializes them, e.g. "rgb(120, 120, 120)". */
  color: string;
  background: string;
  /** 0-1: how far down the document the control sits. */
  positionRatio: number;
}

export interface RawOverlay {
  /** Fraction of the viewport the element covers, 0-1. */
  coverage: number;
  zIndex: number;
  text: string;
}

export type PermissionState = "granted" | "denied" | "prompt" | "unsupported" | "error";

export interface RawPermission {
  name: string;
  state: PermissionState;
}

export interface RawApplicationSignals {
  url: string;
  title: string;
  fields: RawFormField[];
  formCount: number;
  resources: RawResource[];
  checkboxes: RawCheckbox[];
  controls: RawControl[];
  textLines: string[];
  overlays: RawOverlay[];
  scrollLocked: boolean;
  /** Cookies readable from the page — HttpOnly ones are invisible here. Values are never read. */
  cookieCount: number;
  cookieNames: string[];
  localStorageKeys: number;
  sessionStorageKeys: number;
  /** Set when storage could not be read at all (blocked cookies, sandboxed frame). */
  storageNote: string;
  permissions: RawPermission[];
  crossOriginFrames: number;
  /** Collections that hit their collection cap, so the counts below them are floors. */
  truncated: string[];
}

// ---- Finding shapes ---------------------------------------------------------------------------

export type FindingBasis = "observed" | "pattern";

export interface Evidence {
  text: string;
  detail?: string;
}

export interface Finding {
  id: string;
  title: string;
  explanation: string;
  basis: FindingBasis;
  evidence: Evidence[];
}

export type SectionId = "requested-data" | "third-parties" | "pressure" | "storage";

export interface ApplicationSection {
  id: SectionId;
  title: string;
  /** Shown instead of findings, so an empty section reads as "looked, found nothing". */
  emptyNote: string;
  findings: Finding[];
}

export interface ApplicationReport {
  host: string;
  sections: ApplicationSection[];
  notChecked: Limit[];
  findingCount: number;
}

// ---- Requested data ---------------------------------------------------------------------------

export type DataCategory =
  | "password"
  | "payment_card"
  | "government_id"
  | "date_of_birth"
  | "postal_address"
  | "phone"
  | "email"
  | "full_name";

export const DATA_CATEGORY_LABELS: Record<DataCategory, string> = {
  password: "Password",
  payment_card: "Payment card",
  government_id: "Government ID",
  date_of_birth: "Date of birth",
  postal_address: "Postal address",
  phone: "Phone number",
  email: "Email address",
  full_name: "Name",
};

const IGNORED_INPUT_TYPES = new Set(["hidden", "submit", "button", "image", "reset", "checkbox", "radio", "file", "range", "color"]);

/** Ordered: the first match wins, so "cardholder name" is payment, not a plain name field. */
const FIELD_RULES: { category: DataCategory; test: RegExp }[] = [
  { category: "payment_card", test: /\b(cc-|cc_)|card ?(number|holder|no)|cardnumber|credit ?card|debit ?card|\bcvv\b|\bcvc\b|\bcsc\b|security ?code|exp(iry|iration)|payment ?(card|method)/ },
  { category: "government_id", test: /\bssn\b|social ?security|passport|national ?id|\bnino\b|tax ?id|\btin\b|driver'?s? ?licen[cs]e|id ?number|identity ?(card|number)/ },
  { category: "date_of_birth", test: /\bdob\b|\bbday\b|birth ?(date|day)|date ?of ?birth|\bbirthdate\b/ },
  { category: "postal_address", test: /address|street|\bzip\b|postal ?code|postcode|\bcity\b|\btown\b|province|\bcounty\b|address-line/ },
  { category: "phone", test: /\bphone\b|\btel\b|telephone|mobile ?(number|phone)|\bcell\b|\bsms\b/ },
  { category: "email", test: /e-?mail/ },
  { category: "full_name", test: /\b(first|last|given|family|full|sur) ?name\b|\bfname\b|\blname\b|^name$|\bname\b/ },
];

const SEARCH_FIELD = /\bsearch\b|\bquery\b|\bkeyword/;

/** The label a reader would recognise: whatever the page actually shows next to the input. */
export function fieldDisplayName(field: RawFormField): string {
  const candidate =
    field.label || field.ariaLabel || field.placeholder || field.name || field.id || `${field.type || field.tag} field`;
  const clean = candidate.replace(/\s+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
}

export function classifyField(field: RawFormField): DataCategory | null {
  const type = field.type.toLowerCase();
  if (IGNORED_INPUT_TYPES.has(type)) return null;
  if (type === "password") return "password";

  const haystack = [field.autocomplete, field.name, field.id, field.label, field.ariaLabel, field.placeholder, type]
    .join(" ")
    .toLowerCase();

  if (type === "search" || SEARCH_FIELD.test(haystack)) return null;
  if (type === "email") return "email";
  if (type === "tel") return "phone";

  for (const rule of FIELD_RULES) {
    if (rule.test.test(haystack)) return rule.category;
  }
  return null;
}

export interface RequestedDataGroup {
  category: DataCategory;
  label: string;
  fields: string[];
  required: boolean;
}

export function groupRequestedData(fields: RawFormField[]): RequestedDataGroup[] {
  const groups = new Map<DataCategory, RequestedDataGroup>();
  for (const field of fields) {
    const category = classifyField(field);
    if (!category) continue;
    const group = groups.get(category) ?? {
      category,
      label: DATA_CATEGORY_LABELS[category],
      fields: [],
      required: false,
    };
    const name = fieldDisplayName(field);
    if (!group.fields.includes(name)) group.fields.push(name);
    group.required ||= field.required;
    groups.set(category, group);
  }
  // Most revealing first, so a page asking for an ID leads with that rather than with its email box.
  const order: DataCategory[] = [
    "government_id",
    "payment_card",
    "date_of_birth",
    "postal_address",
    "password",
    "phone",
    "email",
    "full_name",
  ];
  return order.filter((c) => groups.has(c)).map((c) => groups.get(c)!);
}

// ---- Third parties ----------------------------------------------------------------------------

export type TrackerCategory = "analytics" | "advertising" | "session_recording" | "consent" | "marketing" | "error_monitoring";

export const TRACKER_CATEGORY_LABELS: Record<TrackerCategory, string> = {
  analytics: "Analytics",
  advertising: "Advertising",
  session_recording: "Session recording",
  consent: "Consent management",
  marketing: "Marketing automation",
  error_monitoring: "Error monitoring",
};

/**
 * A short, deliberately incomplete list of well-known domains. It exists so a reader recognises a
 * name, not so the panel can claim the page is clean when nothing matches. Matched against the
 * registrable domain.
 */
export const KNOWN_TRACKERS: { domain: string; label: string; category: TrackerCategory }[] = [
  { domain: "google-analytics.com", label: "Google Analytics", category: "analytics" },
  { domain: "googletagmanager.com", label: "Google Tag Manager", category: "analytics" },
  { domain: "analytics.google.com", label: "Google Analytics", category: "analytics" },
  { domain: "doubleclick.net", label: "Google DoubleClick", category: "advertising" },
  { domain: "googlesyndication.com", label: "Google AdSense", category: "advertising" },
  { domain: "googleadservices.com", label: "Google Ads", category: "advertising" },
  { domain: "facebook.net", label: "Meta Pixel", category: "advertising" },
  { domain: "facebook.com", label: "Meta", category: "advertising" },
  { domain: "hotjar.com", label: "Hotjar", category: "session_recording" },
  { domain: "clarity.ms", label: "Microsoft Clarity", category: "session_recording" },
  { domain: "fullstory.com", label: "FullStory", category: "session_recording" },
  { domain: "mouseflow.com", label: "Mouseflow", category: "session_recording" },
  { domain: "luckyorange.com", label: "Lucky Orange", category: "session_recording" },
  { domain: "crazyegg.com", label: "Crazy Egg", category: "session_recording" },
  { domain: "segment.com", label: "Segment", category: "analytics" },
  { domain: "segment.io", label: "Segment", category: "analytics" },
  { domain: "mixpanel.com", label: "Mixpanel", category: "analytics" },
  { domain: "amplitude.com", label: "Amplitude", category: "analytics" },
  { domain: "matomo.cloud", label: "Matomo", category: "analytics" },
  { domain: "chartbeat.com", label: "Chartbeat", category: "analytics" },
  { domain: "parsely.com", label: "Parse.ly", category: "analytics" },
  { domain: "scorecardresearch.com", label: "Comscore", category: "analytics" },
  { domain: "quantserve.com", label: "Quantcast", category: "advertising" },
  { domain: "criteo.com", label: "Criteo", category: "advertising" },
  { domain: "criteo.net", label: "Criteo", category: "advertising" },
  { domain: "taboola.com", label: "Taboola", category: "advertising" },
  { domain: "outbrain.com", label: "Outbrain", category: "advertising" },
  { domain: "adroll.com", label: "AdRoll", category: "advertising" },
  { domain: "adnxs.com", label: "Xandr", category: "advertising" },
  { domain: "rubiconproject.com", label: "Magnite", category: "advertising" },
  { domain: "pubmatic.com", label: "PubMatic", category: "advertising" },
  { domain: "amazon-adsystem.com", label: "Amazon Ads", category: "advertising" },
  { domain: "bing.com", label: "Microsoft Advertising", category: "advertising" },
  { domain: "tiktok.com", label: "TikTok Pixel", category: "advertising" },
  { domain: "ads-twitter.com", label: "X Ads", category: "advertising" },
  { domain: "pinterest.com", label: "Pinterest Tag", category: "advertising" },
  { domain: "snapchat.com", label: "Snap Pixel", category: "advertising" },
  { domain: "sc-static.net", label: "Snap Pixel", category: "advertising" },
  { domain: "linkedin.com", label: "LinkedIn Insight", category: "advertising" },
  { domain: "licdn.com", label: "LinkedIn Insight", category: "advertising" },
  { domain: "yandex.ru", label: "Yandex Metrica", category: "analytics" },
  { domain: "onetrust.com", label: "OneTrust", category: "consent" },
  { domain: "cookielaw.org", label: "OneTrust", category: "consent" },
  { domain: "cookiebot.com", label: "Cookiebot", category: "consent" },
  { domain: "usercentrics.eu", label: "Usercentrics", category: "consent" },
  { domain: "trustarc.com", label: "TrustArc", category: "consent" },
  { domain: "hubspot.com", label: "HubSpot", category: "marketing" },
  { domain: "hs-scripts.com", label: "HubSpot", category: "marketing" },
  { domain: "klaviyo.com", label: "Klaviyo", category: "marketing" },
  { domain: "attentivemobile.com", label: "Attentive", category: "marketing" },
  { domain: "braze.com", label: "Braze", category: "marketing" },
  { domain: "intercom.io", label: "Intercom", category: "marketing" },
  { domain: "drift.com", label: "Drift", category: "marketing" },
  { domain: "mailchimp.com", label: "Mailchimp", category: "marketing" },
  { domain: "listrak.com", label: "Listrak", category: "marketing" },
  { domain: "privy.com", label: "Privy", category: "marketing" },
  { domain: "justuno.com", label: "Justuno", category: "marketing" },
  { domain: "optimizely.com", label: "Optimizely", category: "analytics" },
  { domain: "branch.io", label: "Branch", category: "marketing" },
  { domain: "appsflyer.com", label: "AppsFlyer", category: "marketing" },
  { domain: "sentry.io", label: "Sentry", category: "error_monitoring" },
  { domain: "newrelic.com", label: "New Relic", category: "error_monitoring" },
  { domain: "nr-data.net", label: "New Relic", category: "error_monitoring" },
  { domain: "bugsnag.com", label: "Bugsnag", category: "error_monitoring" },
  { domain: "datadoghq.com", label: "Datadog", category: "error_monitoring" },
];

const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "co.jp", "ne.jp", "or.jp", "co.nz", "co.za",
  "com.au", "net.au", "org.au", "gov.au", "com.br", "com.cn", "com.hk", "com.mx", "com.sg",
  "com.tr", "co.in", "co.kr", "co.il", "com.ar", "com.co",
]);

/** Approximate registrable domain — good enough to group hosts a reader would call "the same site". */
export function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

export interface ThirdParty {
  domain: string;
  kinds: RawResource["kind"][];
  count: number;
  tracker?: { label: string; category: TrackerCategory };
}

export function matchKnownTracker(domain: string): { label: string; category: TrackerCategory } | undefined {
  const hit = KNOWN_TRACKERS.find((t) => domain === t.domain || domain.endsWith(`.${t.domain}`));
  return hit ? { label: hit.label, category: hit.category } : undefined;
}

export function summarizeThirdParties(resources: RawResource[], pageUrl: string): ThirdParty[] {
  let pageDomain = "";
  try {
    pageDomain = registrableDomain(new URL(pageUrl).hostname);
  } catch {
    pageDomain = "";
  }

  const byDomain = new Map<string, ThirdParty>();
  for (const resource of resources) {
    let host = "";
    try {
      const parsed = new URL(resource.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      host = parsed.hostname;
    } catch {
      continue;
    }
    const domain = registrableDomain(host);
    if (!domain || domain === pageDomain) continue;

    const entry = byDomain.get(domain) ?? { domain, kinds: [], count: 0, tracker: matchKnownTracker(domain) };
    entry.count += 1;
    if (!entry.kinds.includes(resource.kind)) entry.kinds.push(resource.kind);
    byDomain.set(domain, entry);
  }

  // Recognised names first — they are the ones a reader can act on.
  return Array.from(byDomain.values()).sort((a, b) => {
    if (Boolean(a.tracker) !== Boolean(b.tracker)) return a.tracker ? -1 : 1;
    return b.count - a.count || a.domain.localeCompare(b.domain);
  });
}

const RESOURCE_KIND_LABELS: Record<RawResource["kind"], string> = {
  script: "script",
  iframe: "embedded frame",
  pixel: "tracking pixel",
};

// ---- Dark patterns ----------------------------------------------------------------------------

const DECLINE_TEXT = /\bno,? thank|\bno thanks\b|not now|maybe later|i'?ll pass|i do ?n'?t want|i'?m not interested|dismiss|decline|opt out|unsubscribe|reject/i;

/**
 * Confirmshaming is a decline option written to make the reader feel bad about declining. A bare
 * "No thanks" is not it — the guilt has to be in the words, so both halves must match.
 */
const GUILT_TEXT =
  /i'?d rather|i do ?n'?t (want|need|care|like) (to )?(save|discount|money|deals?|be|stay|get|learn|know)|stay (uninformed|poor|behind|ignorant|boring|ugly)|remain (uninformed|clueless)|miss out|full price|pay more|i hate (saving|money|discounts?)|i'?m (fine|ok|okay) (paying|being|with)|i like (paying|being)|do ?n'?t want to (save|look|feel|be)|keep (struggling|paying)|not interested in (saving|money|discounts?|deals?)/i;

export function isConfirmshaming(text: string): boolean {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length < 12 || clean.length > 160) return false;
  return DECLINE_TEXT.test(clean) && GUILT_TEXT.test(clean);
}

export type ScarcityKind = "stock" | "countdown" | "social_proof" | "urgency";

export const SCARCITY_LABELS: Record<ScarcityKind, string> = {
  stock: "Low-stock claim",
  countdown: "Countdown or deadline",
  social_proof: "Other-shoppers claim",
  urgency: "Urgency wording",
};

const SCARCITY_RULES: { kind: ScarcityKind; test: RegExp }[] = [
  { kind: "stock", test: /\bonly \d+ (left|remaining|in stock|available|spots?|seats?|tickets?)\b|\b\d+ (left|remaining) in stock\b|almost (sold out|gone)|selling (out )?fast|low stock/i },
  { kind: "countdown", test: /\b(ends?|expires?|closes?|offer ends)\s+(in|at)\b|\bends? (today|tonight|soon)\b|\b\d{1,2}\s*:\s*\d{2}(\s*:\s*\d{2})?\b(?=[^]{0,40}(left|remaining|offer|deal|sale|expires?))|\b\d+\s*(hours?|hrs?|minutes?|mins?|days?)\s+(left|remaining)\b/i },
  { kind: "social_proof", test: /\b\d+ (people|others|shoppers|customers|users) (are |have )?(viewing|looking|bought|purchased|booked|signed up)/i },
  { kind: "urgency", test: /\b(hurry|act (now|fast)|last chance|don'?t miss out|limited time|while supplies last|today only|final hours)\b/i },
];

export interface ScarcityHit {
  kind: ScarcityKind;
  line: string;
}

export function detectScarcity(lines: string[]): ScarcityHit[] {
  const hits: ScarcityHit[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || seen.has(line)) continue;
    for (const rule of SCARCITY_RULES) {
      if (!rule.test.test(line)) continue;
      seen.add(line);
      hits.push({ kind: rule.kind, line: line.length > 120 ? `${line.slice(0, 120)}…` : line });
      break;
    }
  }
  return hits;
}

const EXIT_CONTROL = /unsubscribe|cancel (my |your )?(subscription|plan|membership|account|order)|opt[- ]out|manage (preferences|cookies|settings|consent)|reject all|decline|delete (my )?account|close account|no,? thank|no thanks/i;
const ACCEPT_CONTROL = /accept( all)?|agree|allow all|got it|i (agree|accept|understand)|subscribe|sign up|join|continue|buy now|add to (cart|bag)|checkout|yes,? /i;

export function parseColor(value: string): [number, number, number] | null {
  const nums = value.match(/-?\d*\.?\d+/g);
  if (!nums || nums.length < 3) return null;
  const [r, g, b] = nums.slice(0, 3).map(Number);
  if ([r, g, b].some((n) => Number.isNaN(n))) return null;
  return [r, g, b];
}

export function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number): number => {
    const c = Math.min(255, Math.max(0, v)) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1-21. Null when either colour could not be parsed — then we claim nothing. */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) return null;
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return Math.round(((light + 0.05) / (dark + 0.05)) * 10) / 10;
}

export interface DeemphasisHit {
  control: RawControl;
  reasons: string[];
}

/**
 * An exit control (unsubscribe, cancel, reject) is de-emphasised when it is measurably harder to
 * see or reach than the page's accept action. Each reason carries the measurement behind it.
 */
export function findDeemphasisedExits(controls: RawControl[]): DeemphasisHit[] {
  const accepts = controls.filter((c) => ACCEPT_CONTROL.test(c.text) && !EXIT_CONTROL.test(c.text));
  const exits = controls.filter((c) => EXIT_CONTROL.test(c.text));
  if (!exits.length) return [];

  const acceptSizes = accepts.map((c) => c.fontSizePx).filter((n) => n > 0).sort((a, b) => a - b);
  const medianAccept = acceptSizes.length ? acceptSizes[Math.floor(acceptSizes.length / 2)] : 0;
  const topAccept = accepts.length ? Math.min(...accepts.map((c) => c.positionRatio)) : 1;

  const hits: DeemphasisHit[] = [];
  for (const control of exits) {
    const reasons: string[] = [];
    if (medianAccept > 0 && control.fontSizePx > 0 && control.fontSizePx <= medianAccept - 2) {
      reasons.push(`${Math.round(control.fontSizePx)}px text against ${Math.round(medianAccept)}px on the accept action`);
    } else if (control.fontSizePx > 0 && control.fontSizePx < 11) {
      reasons.push(`${Math.round(control.fontSizePx)}px text — below the size used for body copy`);
    }

    const ratio = contrastRatio(control.color, control.background);
    if (ratio !== null && ratio < 3) {
      reasons.push(`contrast ${ratio}:1 with its background — WCAG asks 4.5:1 of body text`);
    }

    if (control.positionRatio > 0.9 && topAccept < 0.6) {
      reasons.push(`sits ${Math.round(control.positionRatio * 100)}% of the way down the page`);
    }

    if (reasons.length) hits.push({ control, reasons });
  }
  return hits;
}

const MARKETING_CONSENT =
  /newsletter|subscribe|marketing|promotion|offers?|deals?|updates|email me|text me|sms|partners|third part|share (my|your) (data|info)|personalis|personaliz|advertis|tailored/i;

const GATE_RULES: { test: RegExp; label: string }[] = [
  { test: /\b(sign in|log ?in|create an account|register|sign up) to (continue|read|view|see|keep)/i, label: "Account wall" },
  { test: /\bsubscribe to (read|continue|keep reading|view)/i, label: "Paywall" },
  { test: /\b(members|subscribers) only\b/i, label: "Members-only gate" },
  { test: /\byou'?(ve| have) (reached|hit) your (free )?(article |story )?limit/i, label: "Article limit" },
  { test: /\b\d+ free (articles?|stories) (left|remaining)/i, label: "Article limit" },
  { test: /\bcontinue reading with (a )?(subscription|free account)/i, label: "Paywall" },
];

export interface GateHit {
  label: string;
  line: string;
}

export function detectGates(lines: string[]): GateHit[] {
  const hits: GateHit[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || seen.has(line)) continue;
    for (const rule of GATE_RULES) {
      if (!rule.test.test(line)) continue;
      seen.add(line);
      hits.push({ label: rule.label, line: line.length > 120 ? `${line.slice(0, 120)}…` : line });
      break;
    }
  }
  return hits;
}

// ---- Report -----------------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function requestedDataFindings(signals: RawApplicationSignals): Finding[] {
  const groups = groupRequestedData(signals.fields);
  if (!groups.length) return [];
  return groups.map((group) => ({
    id: `data-${group.category}`,
    title: `Asks for your ${group.label.toLowerCase()}`,
    explanation:
      group.category === "password"
        ? "The page has a password box, so it expects an account. Nothing here shows what happens to what you type."
        : `${plural(group.fields.length, "input")} on this page collect${group.fields.length === 1 ? "s" : ""} this.${group.required ? " At least one is marked required." : ""}`,
    basis: "observed" as const,
    evidence: group.fields.map((name) => ({ text: name })),
  }));
}

function thirdPartyFindings(signals: RawApplicationSignals): Finding[] {
  const parties = summarizeThirdParties(signals.resources, signals.url);
  if (!parties.length) return [];

  const findings: Finding[] = [];
  const recognised = parties.filter((p) => p.tracker);
  if (recognised.length) {
    findings.push({
      id: "third-parties-known",
      title: `${plural(recognised.length, "recognised tracking or analytics domain")} on this page`,
      explanation:
        "These domains match a short hand-written list of well-known analytics, advertising and session-recording services. " +
        "Matching the list is not proof of what they do here, and the domains below the list are not cleared by it.",
      basis: "pattern",
      evidence: recognised.map((p) => ({
        text: `${p.tracker!.label} — ${p.domain}`,
        detail: `${TRACKER_CATEGORY_LABELS[p.tracker!.category]} · ${p.kinds.map((k) => RESOURCE_KIND_LABELS[k]).join(", ")}`,
      })),
    });
  }

  const others = parties.filter((p) => !p.tracker);
  if (others.length) {
    findings.push({
      id: "third-parties-other",
      title: `${plural(others.length, "other outside domain")} loaded into this page`,
      explanation:
        "Code and frames from these domains run inside the page and can see that you are here. Some will be fonts, " +
        "video players or payment forms; the page does not say which is which.",
      basis: "observed",
      evidence: others.slice(0, 25).map((p) => ({
        text: p.domain,
        detail: `${plural(p.count, "resource")} · ${p.kinds.map((k) => RESOURCE_KIND_LABELS[k]).join(", ")}`,
      })),
    });
  }
  return findings;
}

function pressureFindings(signals: RawApplicationSignals): Finding[] {
  const findings: Finding[] = [];

  const preChecked = signals.checkboxes.filter((c) => c.defaultChecked);
  const marketing = preChecked.filter((c) => MARKETING_CONSENT.test(`${c.label} ${c.name}`));
  const plainPreChecked = preChecked.filter((c) => !marketing.includes(c));

  if (marketing.length) {
    findings.push({
      id: "prechecked-marketing",
      title: `${plural(marketing.length, "marketing or sharing box")} ticked for you`,
      explanation:
        "These boxes arrived already ticked, and their wording mentions marketing, offers or sharing data. " +
        "Consent you did not give is the point of a pre-ticked box. The wording match is ours; read the box itself.",
      basis: "pattern",
      evidence: marketing.map((c) => ({ text: truncate(c.label || c.name || "unlabelled checkbox", 140) })),
    });
  }
  if (plainPreChecked.length) {
    findings.push({
      id: "prechecked",
      title: `${plural(plainPreChecked.length, "box")} already ticked`,
      explanation:
        "These were ticked before you touched anything. Some are harmless (staying signed in); check what each one agrees to.",
      basis: "observed",
      evidence: plainPreChecked.map((c) => ({ text: truncate(c.label || c.name || "unlabelled checkbox", 140) })),
    });
  }

  const shaming = signals.controls.filter((c) => isConfirmshaming(c.text));
  if (shaming.length) {
    findings.push({
      id: "confirmshaming",
      title: "The way out is written to make you feel bad",
      explanation:
        "A decline option phrased as self-criticism — confirmshaming. The wording is matched against a list of guilt " +
        "phrases, so read the text below and judge it yourself.",
      basis: "pattern",
      evidence: shaming.map((c) => ({ text: `“${truncate(c.text, 140)}”` })),
    });
  }

  const scarcity = detectScarcity(signals.textLines);
  if (scarcity.length) {
    findings.push({
      id: "scarcity",
      title: `${plural(scarcity.length, "urgency or scarcity claim")}`,
      explanation:
        "Wording that pushes you to decide now. Nothing here checks whether the claim is true — a stock count or a " +
        "timer can be set to any value the site likes, and often resets on reload.",
      basis: "pattern",
      evidence: scarcity.slice(0, 12).map((hit) => ({ text: `“${hit.line}”`, detail: SCARCITY_LABELS[hit.kind] })),
    });
  }

  const deemphasised = findDeemphasisedExits(signals.controls);
  if (deemphasised.length) {
    findings.push({
      id: "buried-exit",
      title: `${plural(deemphasised.length, "way out", "ways out")} that are easy to miss`,
      explanation:
        "The control that lets you leave, cancel or refuse is smaller, fainter or further down the page than the one " +
        "that agrees — or too small and faint to read on its own terms. Every measurement below is taken from the " +
        "page as it is rendered to you.",
      basis: "observed",
      evidence: deemphasised.slice(0, 8).map((hit) => ({
        text: `“${truncate(hit.control.text, 80)}”`,
        detail: hit.reasons.join("; "),
      })),
    });
  }

  const blocking = signals.overlays.filter((o) => o.coverage >= 0.25);
  if (blocking.length || signals.scrollLocked) {
    const evidence: Evidence[] = blocking.map((o) => ({
      text: o.text ? `“${truncate(o.text, 120)}”` : "Overlay with no readable text",
      detail: `covers ${Math.round(o.coverage * 100)}% of the window`,
    }));
    if (signals.scrollLocked) evidence.push({ text: "Page scrolling is switched off while the overlay is up" });
    findings.push({
      id: "overlay",
      title: blocking.length ? `${plural(blocking.length, "overlay")} sitting over the page` : "Page scrolling is switched off",
      explanation: blocking.length
        ? "Something is covering what you came to read until you respond to it. Cookie prompts, newsletter boxes and " +
          "app nags all look alike from the DOM; the text below says which this is."
        : "The page has turned off scrolling, which usually means it is waiting on a prompt. Nothing large enough to " +
          "call an overlay was found, so what is holding the page is not visible from here.",
      basis: "observed",
      evidence,
    });
  }

  const gates = detectGates(signals.textLines);
  if (gates.length) {
    findings.push({
      id: "gate",
      title: "The page asks for an account or a subscription to continue",
      explanation:
        "Wording on the page offers reading in exchange for signing up or paying. Matched by phrasing, so a page " +
        "merely describing a paywall would also show up here.",
      basis: "pattern",
      evidence: gates.slice(0, 6).map((hit) => ({ text: `“${hit.line}”`, detail: hit.label })),
    });
  }

  return findings;
}

function storageFindings(signals: RawApplicationSignals): Finding[] {
  const findings: Finding[] = [];

  const storageEvidence: Evidence[] = [];
  if (signals.cookieCount > 0) {
    storageEvidence.push({
      text: `${plural(signals.cookieCount, "cookie")} readable from the page`,
      detail: signals.cookieNames.length ? `names only: ${signals.cookieNames.join(", ")}` : undefined,
    });
  }
  if (signals.localStorageKeys > 0) storageEvidence.push({ text: `${plural(signals.localStorageKeys, "entry", "entries")} in localStorage — kept until deleted` });
  if (signals.sessionStorageKeys > 0) storageEvidence.push({ text: `${plural(signals.sessionStorageKeys, "entry", "entries")} in sessionStorage — cleared when the tab closes` });
  if (signals.storageNote) storageEvidence.push({ text: signals.storageNote });

  if (storageEvidence.length) {
    findings.push({
      id: "storage",
      title: "What the site has stored in your browser",
      explanation:
        "Counts and names only — no value is ever read. Cookies marked HttpOnly cannot be seen from the page at all, " +
        "so treat this as a floor.",
      basis: "observed",
      evidence: storageEvidence,
    });
  }

  const granted = signals.permissions.filter((p) => p.state === "granted");
  const asked = signals.permissions.filter((p) => p.state === "denied");
  if (granted.length) {
    findings.push({
      id: "permissions-granted",
      title: `${plural(granted.length, "browser permission")} already granted to this site`,
      explanation: "The site can use these right now without asking again. Chrome's site settings is where you take them back.",
      basis: "observed",
      evidence: granted.map((p) => ({ text: p.name })),
    });
  }
  if (asked.length) {
    findings.push({
      id: "permissions-denied",
      title: `${plural(asked.length, "permission")} blocked for this site`,
      explanation: "Blocked — either you refused it or the browser did. The site may still prompt through other routes.",
      basis: "observed",
      evidence: asked.map((p) => ({ text: p.name })),
    });
  }

  return findings;
}

function notCheckedLines(signals: RawApplicationSignals): Limit[] {
  const lines: Limit[] = [
    limit(
      "no network traffic",
      "Network traffic is not watched. This reads the page as it stands right now, so anything loaded after the scan, " +
        "or served from the site's own domain, does not appear here.",
    ),
    limit(
      "tracker list is partial",
      "The tracker list is a short hand-written set of well-known domains. A domain missing from it may still be tracking you.",
    ),
    limit(
      "unrecognised wording",
      "Dark patterns are matched by wording and by measured size, colour and position. Manipulation phrased in words we " +
        "do not recognise, or carried in an image or video, is missed.",
    ),
    limit(
      "no policy is read",
      "What the site does with what you submit — who it shares with, how long it keeps it — is not visible from the page. " +
        "No privacy policy is read.",
    ),
    limit(
      "httpOnly cookies",
      "HttpOnly cookies cannot be read from a page, so the cookie count is a floor. Cookie values are never read.",
    ),
  ];
  if (signals.crossOriginFrames > 0) {
    const frames = signals.crossOriginFrames;
    lines.push(
      limit(
        `${plural(frames, "frame")} unreadable`,
        `${plural(frames, "frame")} on this page ${frames === 1 ? "comes" : "come"} from another site and cannot be read ` +
          `into, so any form, tracker or dark pattern inside ${frames === 1 ? "it" : "them"} is invisible here.`,
      ),
    );
  }
  const unsupported = signals.permissions.filter((p) => p.state !== "granted" && p.state !== "denied" && p.state !== "prompt");
  if (unsupported.length) {
    lines.push(
      limit("permission state unknown", `Permission state could not be read for: ${unsupported.map((p) => p.name).join(", ")}.`),
    );
  }
  if (signals.truncated.length) {
    lines.push(limit("very large page", `Very large page: only the first batch of ${signals.truncated.join(", ")} was examined.`));
  }
  lines.push(
    limit(
      "boxes ticked by script",
      "A box the page ticks with JavaScript after loading looks the same to you as one ticked in its HTML, but only the " +
        "second is counted here as pre-ticked.",
    ),
  );
  lines.push(
    limit("anything behind a click", "Forms and prompts that only appear after a click, a scroll or a login are not seen by this scan."),
  );
  return lines;
}

export function buildApplicationReport(signals: RawApplicationSignals): ApplicationReport {
  let host = signals.url;
  try {
    host = new URL(signals.url).hostname;
  } catch {
    /* a page with no parseable URL still gets a report */
  }

  const sections: ApplicationSection[] = [
    {
      id: "requested-data",
      title: "What it asks you for",
      emptyNote: "No inputs on this page collect personal details we recognise.",
      findings: requestedDataFindings(signals),
    },
    {
      id: "third-parties",
      title: "Who else is on this page",
      emptyNote: "No scripts, frames or pixels from another domain were in the page when it was scanned.",
      findings: thirdPartyFindings(signals),
    },
    {
      id: "pressure",
      title: "Where it leans on you",
      emptyNote: "No pre-ticked boxes, guilt-worded declines, urgency claims, buried exits or blocking overlays matched.",
      findings: pressureFindings(signals),
    },
    {
      id: "storage",
      title: "What it keeps and what it can use",
      emptyNote: "Nothing readable in cookies or browser storage, and no permission granted to this site.",
      findings: storageFindings(signals),
    },
  ];

  return {
    host,
    sections,
    notChecked: notCheckedLines(signals),
    findingCount: sections.reduce((total, section) => total + section.findings.length, 0),
  };
}
