import { describe, expect, it } from "vitest";
import {
  buildNotChecked,
  classifyField,
  effectiveDomain,
  emptyFindingsMessage,
  findingsSummary,
  hasPunycodeLabel,
  hostFromLinkText,
  isUrlShortener,
  readSecuritySignals,
} from "../src/lib/security-heuristics";
import type { FieldSignal, FormSignal, LinkSignal, SecuritySignals } from "../src/lib/security-heuristics";

function field(partial: Partial<FieldSignal> = {}): FieldSignal {
  return { tag: "input", type: "text", name: "", id: "", autocomplete: "", placeholder: "", ariaLabel: "", ...partial };
}

function form(partial: Partial<FormSignal> = {}): FormSignal {
  return {
    label: "Form 1",
    method: "post",
    action: "https://example.com/submit",
    actionRaw: "/submit",
    hasActionAttribute: true,
    formActions: [],
    fields: [],
    fieldsTruncated: false,
    ...partial,
  };
}

function link(partial: Partial<LinkSignal> = {}): LinkSignal {
  return {
    href: "https://example.com/a",
    hostname: "example.com",
    protocol: "https:",
    text: "Read more",
    target: "",
    rel: "",
    download: false,
    ...partial,
  };
}

function signals(partial: Partial<SecuritySignals> = {}): SecuritySignals {
  return {
    url: "https://example.com/article",
    origin: "https://example.com",
    protocol: "https:",
    hostname: "example.com",
    title: "An article",
    forms: [],
    formsTruncated: false,
    looseSensitiveFields: [],
    links: [],
    linksTruncated: false,
    linkCount: 0,
    codeSources: [],
    codeSourcesTruncated: false,
    mixedContent: [],
    mixedContentTruncated: false,
    frameCount: 0,
    notCollected: [],
    ...partial,
  };
}

/** No output may read as a verdict — false reassurance is this panel's named risk. */
const REASSURANCE = /\b(safe|unsafe|secure|insecure|trusted|trustworthy|legitimate|verified|clean|malicious)\b/i;

describe("a page with nothing wrong", () => {
  const reading = readSecuritySignals(
    signals({
      links: [link(), link({ href: "https://example.com/b", text: "Contact" })],
      linkCount: 2,
    }),
  );

  it("produces no findings", () => {
    expect(reading.findings).toEqual([]);
  });

  it("never reads as a clean bill of health", () => {
    expect(emptyFindingsMessage()).not.toMatch(REASSURANCE);
    expect(emptyFindingsMessage()).toContain("not a judgement");
    expect(findingsSummary([])).toBe("0 things to explain.");
  });

  it("still says what it could not check", () => {
    expect(reading.notChecked.length).toBeGreaterThan(0);
    expect(reading.notChecked.join(" ")).toContain("after this snapshot");
  });

  /**
   * The list is a disclosure, not a backlog. A line only belongs in it if it is still true after
   * the code was written — these were all removed by doing the work, or because no browser API
   * exists and naming the gap only advertises it.
   */
  it("does not keep a limitation that no longer holds", () => {
    const text = reading.notChecked.join(" ").toLowerCase();
    for (const gone of ["certificate", "padlock", "cross-origin frame", "shadow root", "canvas", "short built-in suffix", "not decoded", "who owns this domain"]) {
      expect(text).not.toContain(gone);
    }
  });

  it("produces no aggregate score that could be read as a verdict", () => {
    expect(reading).not.toHaveProperty("score");
    expect(reading).not.toHaveProperty("rating");
    expect(reading).not.toHaveProperty("verdict");
  });
});

describe("transport", () => {
  it("calls out a plain http page, and raises it when a password is asked for", () => {
    const plain = readSecuritySignals(signals({ url: "http://example.com/", origin: "http://example.com", protocol: "http:" }));
    expect(plain.findings.map((f) => f.kind)).toContain("page_over_http");
    expect(plain.findings.find((f) => f.kind === "page_over_http")?.severity).toBe("medium");

    const withLogin = readSecuritySignals(
      signals({
        url: "http://example.com/login",
        origin: "http://example.com",
        protocol: "http:",
        forms: [form({ action: "http://example.com/login", fields: [field({ type: "password", name: "pw" })] })],
      }),
    );
    expect(withLogin.findings.find((f) => f.kind === "page_over_http")?.severity).toBe("high");
  });

  it("names each plain-http subresource on an encrypted page", () => {
    const reading = readSecuritySignals(
      signals({ mixedContent: [{ kind: "script", url: "http://cdn.tracker.net/a.js" }] }),
    );
    const finding = reading.findings.find((f) => f.kind === "mixed_content");
    expect(finding?.evidence).toContain("script: http://cdn.tracker.net/a.js");
  });
});

describe("forms", () => {
  it("makes a login form posting over http the headline finding", () => {
    const reading = readSecuritySignals(
      signals({
        forms: [
          form({
            label: "Form “Sign in”",
            action: "http://example.com/session",
            fields: [field({ type: "email", name: "email" }), field({ type: "password", name: "password" })],
          }),
        ],
      }),
    );
    const finding = reading.findings.find((f) => f.kind === "form_posts_over_http");
    expect(finding?.severity).toBe("high");
    expect(finding?.evidence[0]).toContain("http://example.com/session");
    expect(reading.findings[0].severity).toBe("high");
  });

  it("names the off-site destination of a form asking for a password", () => {
    const reading = readSecuritySignals(
      signals({
        forms: [form({ action: "https://collect.example-login.ru/p", fields: [field({ type: "password", name: "pw" })] })],
      }),
    );
    const finding = reading.findings.find((f) => f.kind === "form_posts_off_site");
    expect(finding?.severity).toBe("high");
    expect(finding?.title).toContain("collect.example-login.ru");
  });

  it("treats an off-site newsletter form as context, not alarm", () => {
    const reading = readSecuritySignals(
      signals({ forms: [form({ action: "https://list.mailer.com/subscribe", fields: [field({ type: "email", name: "email" })] })] }),
    );
    expect(reading.findings.find((f) => f.kind === "form_posts_off_site")?.severity).toBe("low");
  });

  it("does not call a subdomain of the same site off-site", () => {
    const reading = readSecuritySignals(
      signals({ forms: [form({ action: "https://accounts.example.com/login", fields: [field({ type: "password" })] })] }),
    );
    expect(reading.findings.map((f) => f.kind)).not.toContain("form_posts_off_site");
  });

  it("reports a password field that belongs to no form at all", () => {
    const reading = readSecuritySignals(
      signals({ looseSensitiveFields: [field({ type: "password", name: "pw" })] }),
    );
    expect(reading.findings.map((f) => f.kind)).toContain("loose_sensitive_fields");
  });

  it("lists what the page asks for and where it goes", () => {
    const reading = readSecuritySignals(
      signals({
        forms: [
          form({
            label: "Form “Pay”",
            action: "https://pay.stripe-like.com/charge",
            fields: [field({ autocomplete: "cc-number", name: "cardnumber" }), field({ name: "cvv" })],
          }),
        ],
      }),
    );
    expect(reading.asks.map((ask) => ask.kind).sort()).toEqual(["card_security_code", "payment_card"]);
    expect(reading.asks[0].destination).toBe("pay.stripe-like.com");
  });
});

describe("link deception", () => {
  it("flags text that reads as one address pointing at another", () => {
    const reading = readSecuritySignals(
      signals({
        links: [link({ text: "www.yourbank.com", href: "https://secure-login.cc/x", hostname: "secure-login.cc" })],
        linkCount: 1,
      }),
    );
    const finding = reading.findings.find((f) => f.kind === "link_text_mismatch");
    expect(finding?.severity).toBe("high");
    expect(finding?.evidence[0]).toBe("“www.yourbank.com” → secure-login.cc");
  });

  it("does not flag a link whose text is its own host under another subdomain", () => {
    const reading = readSecuritySignals(
      signals({ links: [link({ text: "bbc.co.uk", href: "https://www.bbc.co.uk/news", hostname: "www.bbc.co.uk" })], linkCount: 1 }),
    );
    expect(reading.findings.map((f) => f.kind)).not.toContain("link_text_mismatch");
  });

  it("does not mistake library names for hostnames", () => {
    expect(hostFromLinkText("Vue.js")).toBeNull();
    expect(hostFromLinkText("index.php")).toBeNull();
    expect(hostFromLinkText("two words.com")).toBeNull();
    expect(hostFromLinkText("www.example.com")).toBe("example.com");
    expect(hostFromLinkText("https://paypal.com/login")).toBe("paypal.com");
  });

  it("shows an encoded hostname beside what it draws as, and judges neither", () => {
    const reading = readSecuritySignals(
      signals({ url: "https://xn--pypal-4ve.com/", origin: "https://xn--pypal-4ve.com", hostname: "xn--pypal-4ve.com" }),
    );
    const finding = reading.findings.find((f) => f.kind === "punycode_host");
    expect(finding?.evidence).toEqual(["xn--pypal-4ve.com (shown as p\u0430ypal.com)"]);
    expect(finding?.title).not.toMatch(/paypal/i);
    expect(finding?.explanation).not.toMatch(/paypal/i);
  });

  it("decodes an encoded hostname a link points at", () => {
    const reading = readSecuritySignals(
      signals({ links: [link({ href: "https://xn--80ak6aa92e.com/", hostname: "xn--80ak6aa92e.com" })], linkCount: 1 }),
    );
    expect(reading.findings.find((f) => f.kind === "punycode_host")?.evidence).toEqual([
      "xn--80ak6aa92e.com (shown as \u0430\u0440\u0440\u04cf\u0435.com)",
    ]);
  });

  it("names punycode hostnames and shorteners without resolving them", () => {
    const reading = readSecuritySignals(
      signals({
        links: [
          link({ href: "https://xn--pypal-4ve.com/", hostname: "xn--pypal-4ve.com", text: "Log in" }),
          link({ href: "https://bit.ly/3abc", hostname: "bit.ly", text: "Details" }),
        ],
        linkCount: 2,
      }),
    );
    const kinds = reading.findings.map((f) => f.kind);
    expect(kinds).toContain("punycode_host");
    expect(kinds).toContain("shortened_link");
    expect(reading.findings.find((f) => f.kind === "shortened_link")?.severity).toBe("low");
  });

  it("flags a link to a file that runs when opened", () => {
    const reading = readSecuritySignals(
      signals({ links: [link({ href: "https://files.example.net/setup.exe", hostname: "files.example.net", text: "Download" })], linkCount: 1 }),
    );
    expect(reading.findings.map((f) => f.kind)).toContain("executable_download");
  });

  it("flags a cross-origin new-tab link with no rel=noopener, and not a same-site one", () => {
    const reading = readSecuritySignals(
      signals({
        links: [
          link({ href: "https://other.net/x", hostname: "other.net", target: "_blank" }),
          link({ href: "https://third.net/x", hostname: "third.net", target: "_blank", rel: "noopener" }),
          link({ href: "https://example.com/x", hostname: "example.com", target: "_blank" }),
        ],
        linkCount: 3,
      }),
    );
    const finding = reading.findings.find((f) => f.kind === "blank_target_no_noopener");
    expect(finding?.evidence).toEqual(["https://other.net/x"]);
  });
});

describe("frames", () => {
  const paymentFrame = (partial: Partial<SecuritySignals> = {}): SecuritySignals =>
    signals({
      url: "https://pay.example.net/checkout",
      origin: "https://pay.example.net",
      hostname: "pay.example.net",
      ...partial,
    });

  it("says a form is inside a frame rather than implying the page wrote it", () => {
    const reading = readSecuritySignals(signals({ frameCount: 1 }), [
      paymentFrame({
        forms: [
          form({
            label: "Form “Pay”",
            action: "https://collector.example.org/p",
            fields: [field({ autocomplete: "cc-number", name: "cardnumber" })],
          }),
        ],
      }),
    ]);
    const finding = reading.findings.find((f) => f.kind === "form_posts_off_site");
    expect(finding?.title).toContain("inside a frame from pay.example.net");
    expect(finding?.evidence).toContain("In frame: https://pay.example.net/checkout");
    expect(reading.asks[0].formLabel).toContain("in a frame from pay.example.net");
  });

  it("reads a frame's form against the frame's own origin, not the page's", () => {
    const reading = readSecuritySignals(signals({ frameCount: 1 }), [
      paymentFrame({ forms: [form({ action: "https://pay.example.net/charge", fields: [field({ type: "password" })] })] }),
    ]);
    expect(reading.findings.map((f) => f.kind)).not.toContain("form_posts_off_site");
    expect(reading.asks[0].destination).toBe("pay.example.net");
  });

  it("attributes a link and a plain-http resource to the frame they were found in", () => {
    const reading = readSecuritySignals(signals({ frameCount: 1 }), [
      paymentFrame({
        links: [link({ href: "https://bit.ly/x", hostname: "bit.ly" })],
        linkCount: 1,
        mixedContent: [{ kind: "image", url: "http://img.example/a.png" }],
      }),
    ]);
    expect(reading.findings.find((f) => f.kind === "shortened_link")?.evidence).toEqual([
      "bit.ly — in frame https://pay.example.net/checkout",
    ]);
    expect(reading.findings.find((f) => f.kind === "mixed_content")?.evidence).toEqual([
      "image: http://img.example/a.png — in frame https://pay.example.net/checkout",
    ]);
  });

  it("counts forms and links across every frame it reached", () => {
    const reading = readSecuritySignals(signals({ frameCount: 1, forms: [form()], linkCount: 3 }), [
      paymentFrame({ forms: [form(), form()], linkCount: 4 }),
    ]);
    expect(reading.counts.forms).toBe(3);
    expect(reading.counts.links).toBe(7);
  });

  it("names the frames that returned nothing, and stays quiet when they all answered", () => {
    const some = buildNotChecked(signals({ frameCount: 3 }), [paymentFrame()]);
    expect(some.some((line) => line.includes("2 frames that returned nothing"))).toBe(true);
    const all = buildNotChecked(signals({ frameCount: 1 }), [paymentFrame()]);
    expect(all.some((line) => line.includes("returned nothing"))).toBe(false);
  });
});

describe("third-party code", () => {
  it("counts distinct origins and grows the severity with the count", () => {
    const few = readSecuritySignals(
      signals({
        codeSources: [
          { kind: "script", url: "https://cdn.a.net/x.js", origin: "https://cdn.a.net" },
          { kind: "iframe", url: "https://ads.b.net/f", origin: "https://ads.b.net" },
          { kind: "script", url: "https://example.com/own.js", origin: "https://example.com" },
        ],
      }),
    );
    const finding = few.findings.find((f) => f.kind === "third_party_code");
    expect(finding?.severity).toBe("low");
    expect(finding?.title).toContain("2 other origins");
    expect(few.counts.thirdPartyOrigins).toBe(2);

    const many = readSecuritySignals(
      signals({
        codeSources: Array.from({ length: 12 }, (_, i) => ({
          kind: "script" as const,
          url: `https://t${i}.net/x.js`,
          origin: `https://t${i}.net`,
        })),
      }),
    );
    expect(many.findings.find((f) => f.kind === "third_party_code")?.severity).toBe("medium");
  });
});

describe("wording", () => {
  it("never states or implies a verdict in any finding", () => {
    const reading = readSecuritySignals(
      signals({
        url: "http://xn--80ak6aa92e.com/login",
        origin: "http://xn--80ak6aa92e.com",
        protocol: "http:",
        hostname: "xn--80ak6aa92e.com",
        forms: [
          form({ action: "http://collect.elsewhere.net/p", fields: [field({ type: "password" }), field({ name: "cardnumber" })] }),
          form({ label: "Form 2", action: "", actionRaw: "javascript:send()", hasActionAttribute: true }),
        ],
        looseSensitiveFields: [field({ type: "password", name: "pw2" })],
        links: [
          link({ text: "paypal.com", href: "https://evil.example/x", hostname: "evil.example" }),
          link({ href: "https://bit.ly/x", hostname: "bit.ly" }),
          link({ href: "https://xn--pypal-4ve.com/", hostname: "xn--pypal-4ve.com" }),
          link({ href: "https://d.example/a.dmg", hostname: "d.example", text: "Get it" }),
          link({ href: "https://o.example/x", hostname: "o.example", target: "_blank" }),
        ],
        linkCount: 5,
        codeSources: [{ kind: "script", url: "https://cdn.x.net/a.js", origin: "https://cdn.x.net" }],
        mixedContent: [{ kind: "image", url: "http://img.x.net/a.png" }],
      }),
    );

    expect(reading.findings.length).toBeGreaterThan(6);
    for (const finding of reading.findings) {
      expect(`${finding.title} ${finding.explanation}`).not.toMatch(REASSURANCE);
      expect(finding.evidence.length).toBeGreaterThan(0);
    }
    expect(findingsSummary(reading.findings)).not.toMatch(REASSURANCE);
    expect(reading.notChecked.join(" ")).not.toMatch(REASSURANCE);
  });

  it("orders findings by severity without summing them", () => {
    const reading = readSecuritySignals(
      signals({
        forms: [form({ action: "http://x.example/p", fields: [field({ type: "password" })] })],
        codeSources: [{ kind: "script", url: "https://cdn.x.net/a.js", origin: "https://cdn.x.net" }],
      }),
    );
    expect(reading.findings[0].severity).toBe("high");
    expect(reading.findings[reading.findings.length - 1].severity).toBe("low");
    expect(findingsSummary(reading.findings)).toMatch(/^\d+ things? to explain \(/);
  });
});

describe("helpers", () => {
  it("finds the registrable domain, including multi-label suffixes", () => {
    expect(effectiveDomain("www.example.com")).toBe("example.com");
    expect(effectiveDomain("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(effectiveDomain("example.com")).toBe("example.com");
    expect(effectiveDomain("192.168.1.1")).toBe("192.168.1.1");
  });

  it("recognises punycode labels and shorteners", () => {
    expect(hasPunycodeLabel("xn--pypal-4ve.com")).toBe(true);
    expect(hasPunycodeLabel("shop.xn--p1ai")).toBe(true);
    expect(hasPunycodeLabel("example.com")).toBe(false);
    expect(isUrlShortener("bit.ly")).toBe(true);
    expect(isUrlShortener("www.tinyurl.com")).toBe(true);
    expect(isUrlShortener("example.com")).toBe(false);
  });

  it("classifies sensitive fields from metadata alone", () => {
    expect(classifyField(field({ type: "password" }))).toBe("password");
    expect(classifyField(field({ autocomplete: "cc-number" }))).toBe("payment_card");
    expect(classifyField(field({ name: "cvv" }))).toBe("card_security_code");
    expect(classifyField(field({ placeholder: "Social Security Number" }))).toBe("government_id");
    expect(classifyField(field({ type: "email" }))).toBe("email");
    expect(classifyField(field({ name: "comment" }))).toBeNull();
  });

  it("admits per-run limits in what it could not check", () => {
    const lines = buildNotChecked(signals({ linksTruncated: true, linkCount: 1200, links: [link()], notCollected: ["A frame."] }));
    expect(lines.some((line) => line.includes("1200"))).toBe(true);
    expect(lines).toContain("A frame.");
  });

  it("says nothing about truncation when nothing was truncated", () => {
    const lines = buildNotChecked(signals({ linkCount: 4000, links: Array.from({ length: 4000 }, () => link()) }));
    expect(lines.some((line) => line.includes("Links past"))).toBe(false);
  });
});
