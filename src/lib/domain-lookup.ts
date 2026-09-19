/**
 * Domain registration lookup over RDAP — the one question about a page that cannot be answered by
 * reading the page: when was this name registered, and who sold it.
 *
 * This is the only part of the Security panel that leaves the machine, and it leaves only when a
 * reader presses a button that has already told them what it sends. Everything here is built so the
 * reader keeps the facts straight afterwards: what came back is attributed to a registry, absence of
 * a record is reported as absence of a record, and a failed lookup says nothing about the domain.
 *
 * No verdict is produced. A registration date is a fact with a date on it; the panel says how old
 * the name is and refuses to turn that into a rating.
 *
 * Parsing is pure and separate from fetching: interpretRdapResponse takes a status code and an
 * already-decoded body, so every shape a registry can return is testable without a network call.
 */

import { effectiveDomain, isIpAddressHost } from "./security-heuristics";

export const RDAP_ENDPOINT = "https://rdap.org/domain/";
export const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * The age below which the panel draws the eye to the number. It is an attention threshold and
 * nothing else: crossing it is not a finding, and sitting above it is not an endorsement.
 */
export const RECENT_REGISTRATION_DAYS = 90;

export interface DomainRecord {
  /** The name the registry echoed back, lowercased, or the name that was asked about. */
  name: string;
  /** ISO timestamps, or null when the registry's record does not carry that event. */
  registered: string | null;
  expires: string | null;
  lastChanged: string | null;
  registrar: string | null;
  statuses: string[];
  /** Whole days between registration and now, or null when there is no usable date. */
  ageDays: number | null;
}

export type DomainLookup =
  | { state: "found"; domain: string; record: DomainRecord }
  | { state: "no_record"; domain: string; detail: string }
  | { state: "unavailable"; domain: string; detail: string }
  | { state: "not_a_domain"; domain: string; detail: string };

/** Only what the lookup reads off a response, so a test can hand it a plain object. */
export interface RdapResponse {
  status: number;
  json(): Promise<unknown>;
}

export type RdapFetch = (url: string, init: RequestInit) => Promise<RdapResponse>;

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Event names vary between registries in case, spacing and vocabulary. Matching is done on a
 * normalized string against a known list rather than on a substring, so "last update of RDAP
 * database" — which is when the directory was refreshed, not when the domain was — cannot be read
 * as a change to the domain.
 */
const REGISTRATION_ACTIONS: ReadonlySet<string> = new Set(["registration", "registered", "creation", "created", "create"]);
const EXPIRATION_ACTIONS: ReadonlySet<string> = new Set(["expiration", "expiry", "expires", "expired"]);
const CHANGE_ACTIONS: ReadonlySet<string> = new Set(["last changed", "last update", "last updated", "updated", "changed", "modification"]);

const MAX_STATUSES = 6;

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizeAction(action: string): string {
  return action.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** An RDAP timestamp as an ISO string, or null for anything unparseable — registries do emit both. */
function toIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function eventDate(events: unknown, actions: ReadonlySet<string>): string | null {
  if (!Array.isArray(events)) return null;
  for (const entry of events) {
    const event = asObject(entry);
    if (!event || typeof event.eventAction !== "string") continue;
    if (!actions.has(normalizeAction(event.eventAction))) continue;
    const date = toIso(event.eventDate);
    if (date) return date;
  }
  return null;
}

/** The display name inside a jCard: ["vcard", [["fn", {}, "text", "Some Registrar, Inc."], …]]. */
function vcardName(vcardArray: unknown): string | null {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return null;
  const entries = vcardArray[1];
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (Array.isArray(entry) && entry[0] === "fn" && typeof entry[3] === "string" && entry[3].trim()) {
      return entry[3].trim();
    }
  }
  return null;
}

/**
 * The registrar entity, which some registries put at the top level and others nest one or two
 * levels down inside another entity. Depth is capped so a self-referential document cannot spin.
 */
function registrarFrom(entities: unknown, depth = 0): string | null {
  if (!Array.isArray(entities) || depth > 2) return null;
  for (const entry of entities) {
    const entity = asObject(entry);
    if (!entity) continue;
    const roles = Array.isArray(entity.roles) ? entity.roles.map((role) => String(role).toLowerCase()) : [];
    if (roles.includes("registrar")) {
      const name = vcardName(entity.vcardArray) ?? (typeof entity.handle === "string" && entity.handle.trim() ? entity.handle.trim() : null);
      if (name) return name;
    }
    const nested = registrarFrom(entity.entities, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function statusesFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, MAX_STATUSES);
}

/**
 * An RDAP domain document turned into the handful of facts worth showing, or null when the body is
 * not a domain record at all. Registries disagree about nearly everything except the shape of the
 * envelope, so every field is optional and absence is normal rather than an error.
 */
export function parseRdapDomain(body: unknown, queried: string, now: Date = new Date()): DomainRecord | null {
  const root = asObject(body);
  if (!root) return null;
  if (typeof root.objectClassName === "string" && root.objectClassName !== "domain") return null;

  const registered = eventDate(root.events, REGISTRATION_ACTIONS);
  const expires = eventDate(root.events, EXPIRATION_ACTIONS);
  const lastChanged = eventDate(root.events, CHANGE_ACTIONS);
  const registrar = registrarFrom(root.entities);
  const statuses = statusesFrom(root.status);
  const named = typeof root.ldhName === "string" && root.ldhName.trim() ? root.ldhName.trim().toLowerCase() : "";

  // A body with no envelope marker and nothing recognisable in it is not a record; saying so is
  // better than presenting an empty one as if the registry had answered.
  const recognisable = root.objectClassName === "domain" || named || registered || expires || lastChanged || registrar || statuses.length > 0;
  if (!recognisable) return null;

  let ageDays: number | null = null;
  if (registered) {
    const elapsed = now.getTime() - Date.parse(registered);
    // A registration date in the future is a broken record, not a domain registered tomorrow.
    ageDays = elapsed >= 0 ? Math.floor(elapsed / MILLISECONDS_PER_DAY) : null;
  }

  return { name: named || queried, registered, expires, lastChanged, registrar, statuses, ageDays };
}

/** The human part of an RDAP error body, when the service bothered to write one. */
function errorDetail(body: unknown): string {
  const root = asObject(body);
  if (!root) return "";
  const title = typeof root.title === "string" ? root.title.trim() : "";
  const description = Array.isArray(root.description)
    ? root.description.filter((line): line is string => typeof line === "string").join(" ").trim()
    : "";
  return [title, description].filter(Boolean).join(" — ").slice(0, 200);
}

/**
 * A status code and a decoded body turned into one of four states. Kept pure so every registry
 * response shape — and every way the service can fail — is covered by tests that touch no network.
 */
export function interpretRdapResponse(args: { domain: string; status: number; body: unknown; now?: Date }): DomainLookup {
  const { domain, status, body, now = new Date() } = args;

  if (status === 404 || status === 400) {
    const detail = errorDetail(body);
    return { state: "no_record", domain, detail: detail || `the directory answered ${status}` };
  }
  if (status === 429) {
    return { state: "unavailable", domain, detail: "the directory is rate-limiting requests right now" };
  }
  if (status < 200 || status >= 300) {
    const detail = errorDetail(body);
    return { state: "unavailable", domain, detail: detail ? `the directory answered ${status} — ${detail}` : `the directory answered ${status}` };
  }

  const record = parseRdapDomain(body, domain, now);
  if (!record) {
    return { state: "unavailable", domain, detail: "the answer was not a domain record this panel can read" };
  }
  return { state: "found", domain, record };
}

/** The name a lookup would actually ask about, or null when there is nothing registrable to ask. */
export function lookupTarget(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host || isIpAddressHost(host) || !host.includes(".")) return null;
  const domain = effectiveDomain(host);
  return domain && domain.includes(".") ? domain : null;
}

function failureDetail(err: unknown, timeoutMs: number): string {
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return `nothing came back within ${Math.round(timeoutMs / 1000)} seconds`;
  }
  if (err instanceof DOMException && err.name === "AbortError") return "the request was stopped";
  const message = err instanceof Error ? err.message : String(err);
  return message ? `the request failed (${message})` : "the request failed";
}

/**
 * Asks rdap.org about a hostname's registrable name. Fires only from a button press: nothing in the
 * scan calls this. Credentials and referrer are withheld — the query is the name and nothing else.
 */
export async function lookupDomain(
  hostname: string,
  options: { fetchImpl?: RdapFetch; now?: Date; timeoutMs?: number } = {},
): Promise<DomainLookup> {
  const domain = lookupTarget(hostname);
  if (!domain) {
    return {
      state: "not_a_domain",
      domain: hostname,
      detail: "there is no registered domain name here to look up — a bare IP address or a local name has no registration record",
    };
  }

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as RdapFetch);
  const timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  try {
    const response = await fetchImpl(`${RDAP_ENDPOINT}${encodeURIComponent(domain)}`, {
      method: "GET",
      redirect: "follow",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      headers: { Accept: "application/rdap+json, application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => null);
    return interpretRdapResponse({ domain, status: response.status, body, now: options.now });
  } catch (err) {
    return { state: "unavailable", domain, detail: failureDetail(err, timeoutMs) };
  }
}

// ---- Wording -----------------------------------------------------------------------------------
// Every sentence a reader sees about a lookup lives here, so the tests that police this panel's
// refusal to issue a verdict cover the network results too.

/** Written on the button's own label area, before anything is sent. */
export function rdapDisclosure(domain: string): string {
  return `Pressing this sends the name ${domain} to rdap.org, a third party, which passes the question on to the registry that runs that top-level domain. Both of them see the name and that someone on this network asked about it. ${domain} itself is not contacted, and nothing else from this page is sent.`;
}

export const REGISTRATION_ATTRIBUTION =
  "This came back over the network from a domain registry. It was not read from the page, and the page has no say in it.";

export const REGISTRATION_CAVEAT =
  "A registration date says when somebody paid for the name. It does not say who is behind it or what the site does. A name registered days ago is worth noticing, because most phishing runs on one — but plenty of ordinary sites are new, and a name registered twenty years ago can have changed hands last week.";

function isoDay(iso: string): string {
  return iso.slice(0, 10);
}

/** Age in the units a person would use, always with the date itself so nothing is rounded away. */
export function ageSentence(record: DomainRecord): string {
  if (!record.registered) return "The record carries no registration date.";
  const day = isoDay(record.registered);
  const days = record.ageDays;
  if (days === null) return `The record's registration date is ${day}, which is in the future — that is a broken record rather than a new domain.`;
  if (days === 0) return `Registered today, ${day}.`;
  if (days === 1) return `Registered yesterday, ${day}.`;
  if (days < 60) return `Registered ${days} days ago, on ${day}.`;
  if (days < 730) {
    const months = Math.round(days / 30.44);
    return `Registered about ${months} month${months === 1 ? "" : "s"} ago, on ${day}.`;
  }
  const years = Math.floor(days / 365.25);
  return `Registered about ${years} year${years === 1 ? "" : "s"} ago, on ${day}.`;
}

/** True when the age is worth drawing the eye to. Deliberately not "true when this is a problem". */
export function isRecentRegistration(record: DomainRecord): boolean {
  return record.ageDays !== null && record.ageDays < RECENT_REGISTRATION_DAYS;
}

/** The short form on the chip beside the domain. */
export function ageChip(record: DomainRecord): string {
  if (record.ageDays === null) return "age not in the record";
  if (record.ageDays === 0) return "registered today";
  if (record.ageDays === 1) return "registered 1 day ago";
  if (record.ageDays < 60) return `registered ${record.ageDays} days ago`;
  if (record.ageDays < 730) return `registered ~${Math.round(record.ageDays / 30.44)} months ago`;
  return `registered ~${Math.floor(record.ageDays / 365.25)} years ago`;
}

export function describeRecord(record: DomainRecord): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (record.registered) rows.push({ label: "Registered", value: isoDay(record.registered) });
  if (record.expires) rows.push({ label: "Registration expires", value: isoDay(record.expires) });
  if (record.lastChanged) rows.push({ label: "Record last changed", value: isoDay(record.lastChanged) });
  if (record.registrar) rows.push({ label: "Sold by", value: record.registrar });
  if (record.statuses.length) rows.push({ label: "Registry status", value: record.statuses.join(", ") });
  return rows;
}

export function noRecordSentence(domain: string): string {
  return `No record came back for ${domain}. Many registries — most country-code ones — publish no RDAP directory at all, and some publish one that answers for only part of what they hold. This is a fact about the directory that was asked, not about the domain.`;
}

export function unavailableSentence(domain: string, detail: string): string {
  return `The lookup for ${domain} did not complete: ${detail}. Nothing was learned either way, and this says nothing about the domain.`;
}
