/**
 * RFC 3492 punycode decoding, so an `xn--` hostname can be shown the way the address bar draws it.
 * Decoding only: nothing here judges a name, compares it to a brand, or scores how confusable it is.
 * The reader is shown what the name says and decides for themselves.
 *
 * No dependency, and no reliance on the browser's own IDN handling — this runs in the side panel
 * over strings that came out of a page, and must behave identically under the test runner.
 */

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const MAX_INT = 0x7fffffff;
const PREFIX = "xn--";

/** A basic code point's numeric value, or BASE when the character is not a punycode digit. */
function digitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26; // 0-9
  if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z
  if (code >= 0x61 && code <= 0x7a) return code - 0x61; // a-z
  return BASE;
}

function adaptBias(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) / 2) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

/**
 * Decodes the part after the `xn--` prefix. Returns null rather than throwing on anything malformed:
 * a hostname that does not decode is reported as the raw label, which is the honest thing to show.
 */
export function decodePunycode(input: string): string | null {
  if (input === "") return null;
  const output: number[] = [];
  const lastDelimiter = input.lastIndexOf("-");
  const basicEnd = lastDelimiter > 0 ? lastDelimiter : 0;

  for (let j = 0; j < basicEnd; j += 1) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) return null;
    output.push(code);
  }

  let index = basicEnd > 0 ? basicEnd + 1 : 0;
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;

  while (index < input.length) {
    const oldI = i;
    let weight = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const digit = digitValue(input.charCodeAt(index));
      index += 1;
      if (digit >= BASE) return null;
      if (digit > Math.floor((MAX_INT - i) / weight)) return null;
      i += digit * weight;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      if (weight > Math.floor(MAX_INT / (BASE - t))) return null;
      weight *= BASE - t;
    }
    const outLength = output.length + 1;
    bias = adaptBias(i - oldI, outLength, oldI === 0);
    if (Math.floor(i / outLength) > MAX_INT - n) return null;
    n += Math.floor(i / outLength);
    i %= outLength;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    output.splice(i, 0, n);
    i += 1;
  }

  return output.length ? String.fromCodePoint(...output) : null;
}

/** Decodes a single hostname label, or returns null when it is not an encoded one. */
export function decodePunycodeLabel(label: string): string | null {
  const lower = label.toLowerCase();
  if (!lower.startsWith(PREFIX)) return null;
  return decodePunycode(lower.slice(PREFIX.length));
}

/**
 * Renders invisible and direction-changing characters as their code points instead of letting them
 * do their job. They are exactly the characters used to make a decoded name read as something it is
 * not, so hiding them here would undo the point of decoding it.
 */
export function revealInvisible(text: string): string {
  return text.replace(
    /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ￹-￻]/g,
    (char) => `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`,
  );
}

/**
 * The hostname as it is drawn, with every encoded label decoded, or null when nothing was encoded
 * or nothing decoded cleanly. Labels that fail to decode are left in their raw form rather than
 * dropping the whole name.
 */
export function decodeHostname(hostname: string): string | null {
  const labels = hostname.toLowerCase().split(".");
  let changed = false;
  const decoded = labels.map((label) => {
    const value = decodePunycodeLabel(label);
    if (value === null) return label;
    changed = true;
    return value;
  });
  return changed ? revealInvisible(decoded.join(".")) : null;
}

/**
 * "xn--pypal-4ve.com (shown as pаypal.com)" — one string a reader can compare at a glance. Falls
 * back to the raw hostname when there is nothing to decode.
 */
export function describeHostname(hostname: string): string {
  const decoded = decodeHostname(hostname);
  return decoded ? `${hostname} (shown as ${decoded})` : hostname;
}
