/**
 * The real Public Suffix List, used to answer one question: given two hostnames, are they the same
 * site or two different ones? "accounts.example.co.uk" and "example.co.uk" are one site;
 * "user-a.github.io" and "user-b.github.io" are two. Getting that wrong in either direction turns
 * into either a missed off-site form or a false one, so the list is the actual list rather than a
 * hand-written approximation of it.
 *
 * Rules are matched against punycode-decoded labels, because the list is written in Unicode
 * ("한국") while a hostname read out of a page is encoded ("xn--3e0b707e"). The value returned is
 * always built from the original labels.
 */

import { PUBLIC_SUFFIX_RULES } from "./public-suffix-list";
import { decodePunycodeLabel } from "./punycode";

interface RuleSets {
  normal: Set<string>;
  /** `*.ck` is stored as "ck": the part that must match after the wildcard label. */
  wildcard: Set<string>;
  /** `!www.ck` is stored as "www.ck". */
  exception: Set<string>;
}

let cached: RuleSets | null = null;

function ruleSets(): RuleSets {
  if (cached) return cached;
  const sets: RuleSets = { normal: new Set(), wildcard: new Set(), exception: new Set() };
  for (const line of PUBLIC_SUFFIX_RULES.split("\n")) {
    const rule = line.trim();
    if (!rule) continue;
    if (rule.startsWith("!")) sets.exception.add(rule.slice(1).toLowerCase());
    else if (rule.startsWith("*.")) sets.wildcard.add(rule.slice(2).toLowerCase());
    else sets.normal.add(rule.toLowerCase());
  }
  cached = sets;
  return sets;
}

function splitLabels(hostname: string): { labels: string[]; matchable: string[] } {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  const matchable = labels.map((label) => decodePunycodeLabel(label) ?? label);
  return { labels, matchable };
}

/**
 * How many trailing labels of this hostname form its public suffix. Follows the algorithm published
 * with the list: exception rules win outright, otherwise the longest matching rule does, and a
 * hostname matching no rule at all is treated as if the rule were "*".
 */
function publicSuffixLength(matchable: readonly string[]): number {
  const { normal, wildcard, exception } = ruleSets();
  const count = matchable.length;
  let exceptionLength = 0;
  let normalLength = 0;

  for (let i = 0; i < count; i += 1) {
    const length = count - i;
    const candidate = matchable.slice(i).join(".");
    if (exceptionLength === 0 && exception.has(candidate)) exceptionLength = length;
    if (normalLength === 0) {
      if (normal.has(candidate)) normalLength = length;
      else if (length >= 2 && wildcard.has(matchable.slice(i + 1).join("."))) normalLength = length;
    }
    if (exceptionLength && normalLength) break;
  }

  if (exceptionLength) return exceptionLength - 1;
  return normalLength || 1;
}

/** The public suffix itself ("co.uk" for "news.bbc.co.uk"), in the hostname's own encoding. */
export function publicSuffix(hostname: string): string {
  const { labels, matchable } = splitLabels(hostname);
  if (!labels[0]) return "";
  const length = publicSuffixLength(matchable);
  return labels.slice(labels.length - Math.min(length, labels.length)).join(".");
}

/**
 * The registrable domain: the public suffix plus the one label someone actually registered. Returns
 * "" when the hostname is a public suffix and nothing more, since there is no registered name in it.
 */
export function registrableDomain(hostname: string): string {
  const { labels, matchable } = splitLabels(hostname);
  if (!labels[0]) return "";
  const length = publicSuffixLength(matchable);
  if (labels.length <= length) return "";
  return labels.slice(labels.length - length - 1).join(".");
}
