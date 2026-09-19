import { describe, expect, it } from "vitest";
import { decodeHostname, decodePunycode, decodePunycodeLabel, describeHostname, revealInvisible } from "../src/lib/punycode";

describe("RFC 3492 decoding", () => {
  it("decodes the sample strings from the specification", () => {
    expect(decodePunycode("egbpdaj6bu4bxfgehfvwxn")).toBe("ليهمابتكلموشعربي؟");
    expect(decodePunycode("ihqwcrb4cv8a8dqg056pqjye")).toBe("他们为什么不说中文");
    expect(decodePunycode("Proprostnemluvesky-uyb24dma41a")).toBe("Pročprostěnemluvíčesky");
    expect(decodePunycode("3B-ww4c5e180e575a65lsy2b")).toBe("3年B組金八先生");
    expect(decodePunycode("2-u9tlzr9756bt3uc0v")).toBe("ひとつ屋根の下2");
  });

  it("decodes a label only when it is actually encoded", () => {
    expect(decodePunycodeLabel("xn--bcher-kva")).toBe("bücher");
    expect(decodePunycodeLabel("XN--BCHER-KVA")).toBe("bücher");
    expect(decodePunycodeLabel("example")).toBeNull();
  });

  it("returns null rather than throwing on anything malformed", () => {
    expect(decodePunycode("")).toBeNull();
    expect(decodePunycode("!!!")).toBeNull();
    expect(decodePunycode("bcher-")).toBe("bcher");
    // One digit short of the specification's own sample: a truncated name decodes to nothing,
    // never to a partial name that would read as a different one.
    expect(decodePunycode("3B-ww4c5e180e575a65lsy")).toBeNull();
    expect(decodeHostname("xn--")).toBeNull();
    expect(decodeHostname("xn--a-é")).toBeNull();
  });
});

describe("hostnames", () => {
  it("shows what the address bar draws for a name that imitates a brand", () => {
    expect(decodeHostname("xn--pypal-4ve.com")).toBe("pаypal.com");
    expect(decodeHostname("xn--80ak6aa92e.com")).toBe("аррӏе.com");
    expect(describeHostname("xn--pypal-4ve.com")).toBe("xn--pypal-4ve.com (shown as pаypal.com)");
  });

  it("decodes every encoded label, including an encoded top-level domain", () => {
    expect(decodeHostname("xn--e1afmkfd.xn--p1ai")).toBe("пример.рф");
    expect(decodeHostname("shop.xn--3e0b707e")).toBe("shop.한국");
  });

  it("leaves a name with nothing encoded in it alone", () => {
    expect(decodeHostname("example.com")).toBeNull();
    expect(describeHostname("example.com")).toBe("example.com");
  });

  it("makes decoded characters that would be invisible visible instead", () => {
    expect(revealInvisible("pay​pal")).toBe("pay<U+200B>pal");
    expect(revealInvisible("‮palpay")).toBe("<U+202E>palpay");
    expect(revealInvisible("bücher")).toBe("bücher");
  });

  it("never decides anything about the name it decoded", () => {
    const shown = describeHostname("xn--pypal-4ve.com");
    expect(shown).not.toMatch(/\b(safe|unsafe|fake|spoof|phish|suspicious|imitat)/i);
  });
});
