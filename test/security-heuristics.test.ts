import { describe, expect, it } from "vitest";
import {
  buildNotChecked,
  classifyField,
  effectiveDomain,
  emptyFindingsMessage,
  findingsSummary,
  groupAsks,
  hasPunycodeLabel,
  hostFromLinkText,
  isUrlShortener,
  linkClaim,
  readSecuritySignals,
} from "../src/lib/security-heuristics";
import type { FieldSignal, FormSignal, LinkSignal, SecuritySignals } from "../src/lib/security-heuristics";

import type { Limit } from "../src/lib/limits";

/** The disclosure as prose: the chips carry short labels, the sentences carry the admission. */
const details = (limits: readonly Limit[]): string => limits.map((entry) => entry.detail).join(" ");

function field(partial: Partial<FieldSignal> = {}): FieldSignal {
  return { tag: "input", type: "text", name: "", id: "", autocomplete: "", placeholder: "", ariaLabel: "", ...partial };
}

function form(partial: Partial<FormSignal> = {}): FormSignal {
  return {
    label: "Form 1",
    action: "https://example.com/submit",
    actionRaw: "/submit",
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
    expect(details(reading.notChecked)).toContain("after this snapshot");
  });

  /**
   * The list is a disclosure, not a backlog. A line only belongs in it if it is still true after
   * the code was written — these were all removed by doing the work, or because no browser API
   * exists and naming the gap only advertises it.
   */
  it("does not keep a limitation that no longer holds", () => {
    const text = details(reading.notChecked).toLowerCase();
    for (const gone of ["certificate", "padlock", "cross-origin frame", "open shadow root", "canvas", "short built-in suffix", "not decoded", "who owns this domain", "named window"]) {
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
    // Medium: from markup alone this is "look before you click", not proof of a trap.
    expect(finding?.severity).toBe("medium");
    expect(finding?.evidence[0]).toBe("“www.yourbank.com” → secure-login.cc");
  });

  it("does not flag a link whose text is its own host under another subdomain", () => {
    const reading = readSecuritySignals(
      signals({ links: [link({ text: "bbc.co.uk", href: "https://www.bbc.co.uk/news", hostname: "www.bbc.co.uk" })], linkCount: 1 }),
    );
    expect(reading.findings.map((f) => f.kind)).not.toContain("link_text_mismatch");
    expect(reading.findings.map((f) => f.kind)).not.toContain("link_wrapped");
  });

  /** The aggregator and newsletter case: the address carries the site the text names. */
  it("reads a redirector that carries its destination as a wrapper, not a disguise", () => {
    const reading = readSecuritySignals(
      signals({
        links: [
          link({ text: "example.org", href: "https://go.redirectingat.com/?url=https%3A%2F%2Fwww.example.org%2Fstory", hostname: "go.redirectingat.com" }),
          link({ text: "example.org", href: "https://news.ycombinator.com/from?site=example.org", hostname: "news.ycombinator.com" }),
        ],
        linkCount: 2,
      }),
    );
    const kinds = reading.findings.map((f) => f.kind);
    expect(kinds).not.toContain("link_text_mismatch");
    const wrapped = reading.findings.find((f) => f.kind === "link_wrapped");
    expect(wrapped?.severity).toBe("low");
    expect(wrapped?.evidence).toHaveLength(2);
  });

  it("does not let a look-alike name in the address vouch for the one in the text", () => {
    expect(
      linkClaim(link({ text: "example.com", href: "https://t.example.net/?u=https://notexample.com/x", hostname: "t.example.net" })),
    ).toBe("mismatch");
    expect(
      linkClaim(link({ text: "example.com", href: "https://t.example.net/?u=https://www.example.com/x", hostname: "t.example.net" })),
    ).toBe("wrapped");
    expect(linkClaim(link({ text: "Read more" }))).toBeNull();
  });

  it("treats address-shaped text on a non-web link as a mismatch and names the target", () => {
    const reading = readSecuritySignals(
      signals({ links: [link({ text: "paypal.com", href: "javascript:go()", hostname: "", protocol: "javascript:" })], linkCount: 1 }),
    );
    expect(reading.findings.find((f) => f.kind === "link_text_mismatch")?.evidence).toEqual(["“paypal.com” → javascript:go()"]);
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
    expect(some.some((line) => line.detail.includes("2 frames that returned nothing"))).toBe(true);
    const all = buildNotChecked(signals({ frameCount: 1 }), [paymentFrame()]);
    expect(all.some((line) => line.detail.includes("returned nothing"))).toBe(false);
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
          form({ label: "Form 2", action: "", actionRaw: "javascript:send()" }),
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
    expect(details(reading.notChecked)).not.toMatch(REASSURANCE);
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
    expect(classifyField(field({ name: "telephone" }))).toBe("phone");
    // "pan" is a card number only as a whole word; a Japan office field is not a payment ask.
    expect(classifyField(field({ name: "japan_office" }))).toBeNull();
    expect(classifyField(field({ name: "pan" }))).toBe("payment_card");
  });

  it("admits per-run limits in what it could not check", () => {
    const lines = buildNotChecked(signals({ linksTruncated: true, linkCount: 1200, links: [link()], forms: [form({ fieldsTruncated: true })] }));
    expect(lines.some((line) => line.detail.includes("1200"))).toBe(true);
    expect(lines.some((line) => line.label === "some fields unread" && line.detail.includes("one form"))).toBe(true);
  });

  it("names closed shadow roots as unreadable without implying open ones are", () => {
    const closed = buildNotChecked(signals()).find((line) => line.label === "closed components");
    expect(closed?.detail).toContain("closed shadow root");
    expect(closed?.detail).toContain("Open ones are read");
  });

  it("says nothing about truncation when nothing was truncated", () => {
    const lines = buildNotChecked(signals({ linkCount: 4000, links: Array.from({ length: 4000 }, () => link()) }));
    expect(lines.some((line) => line.detail.includes("Links past"))).toBe(false);
  });
});

describe("grouping what a page asks for", () => {
  it("puts every value one form collects into a single entry, in the order it asks", () => {
    const reading = readSecuritySignals(
      signals({
        forms: [
          form({
            label: "Checkout",
            fields: [field({ type: "password" }), field({ autocomplete: "cc-number" }), field({ type: "email" })],
          }),
        ],
      }),
    );

    const groups = groupAsks(reading.asks);
    expect(groups).toHaveLength(1);
    expect(groups[0].formLabel).toBe("Checkout");
    expect(groups[0].labels).toEqual(["A password", "A payment card number", "An email address"]);
    expect(groups[0].offSite).toBe(false);
  });

  it("keeps two forms apart even when they post to the same address", () => {
    const reading = readSecuritySignals(
      signals({
        forms: [
          form({ label: "Sign in", fields: [field({ type: "password" })] }),
          form({ label: "Newsletter", fields: [field({ type: "email" })] }),
        ],
      }),
    );

    const groups = groupAsks(reading.asks);
    expect(groups.map((group) => group.formLabel)).toEqual(["Sign in", "Newsletter"]);
  });

  it("marks a form that posts to another origin as leaving the page", () => {
    const reading = readSecuritySignals(
      signals({
        forms: [form({ label: "Sign in", action: "https://pay.other.test/collect", fields: [field({ type: "password" })] })],
      }),
    );

    const groups = groupAsks(reading.asks);
    expect(groups[0].offSite).toBe(true);
    expect(groups[0].destination).toBe("pay.other.test");
  });

  /**
   * The case that made this worth extracting: a form inside a payment provider's frame posting to
   * that provider reads as a hostname rather than "this site", but it is posting home, not away.
   */
  it("does not call a frame's own form off-site just because its destination names a host", () => {
    const frame = signals({
      url: "https://pay.example.net/checkout",
      origin: "https://pay.example.net",
      hostname: "pay.example.net",
      forms: [form({ label: "Card", action: "https://pay.example.net/charge", fields: [field({ autocomplete: "cc-number" })] })],
    });
    const reading = readSecuritySignals(signals({ frameCount: 1 }), [frame]);

    const groups = groupAsks(reading.asks);
    expect(groups).toHaveLength(1);
    expect(groups[0].destination).toBe("pay.example.net");
    expect(groups[0].offSite).toBe(false);
  });

  it("claims nothing either way when the destination cannot be read", () => {
    const reading = readSecuritySignals(
      signals({
        forms: [form({ label: "Sign in", action: "", actionRaw: "", fields: [field({ type: "password" })] })],
      }),
    );

    const groups = groupAsks(reading.asks);
    expect(groups[0].destination).toBe("unknown");
    expect(groups[0].offSite).toBe(false);
  });
});

describe("pointing at the form itself", () => {
  it("tells two identically labelled forms apart, even to the same destination", () => {
    const twin = (label: string) =>
      form({ label, action: "https://collect.test/x", fields: [field({ type: "email" })] });
    const reading = readSecuritySignals(signals({ forms: [twin("Form \u201CSubmit\u201D"), twin("Form \u201CSubmit\u201D")] }));

    const groups = groupAsks(reading.asks);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.formIndex)).toEqual([0, 1]);
  });

  it("carries the destination it read, so a highlight can refuse once the page changes it", () => {
    const reading = readSecuritySignals(
      signals({ forms: [form({ label: "Signup", action: "https://app.example.net/s", fields: [field({ type: "email" })] })] }),
    );

    expect(groupAsks(reading.asks)[0].formAction).toBe("https://app.example.net/s");
  });

  it("records which document a form lives in so the right frame is asked", () => {
    const frame = signals({
      url: "https://widget.example.net/embed",
      origin: "https://widget.example.net",
      hostname: "widget.example.net",
      forms: [form({ label: "Subscribe", action: "https://widget.example.net/go", fields: [field({ type: "email" })] })],
    });
    const reading = readSecuritySignals(
      signals({ frameCount: 1, forms: [form({ label: "Top", fields: [field({ type: "email" })] })] }),
      [frame],
    );

    const byLabel = Object.fromEntries(groupAsks(reading.asks).map((group) => [group.formIndex + "|" + group.frameUrl, group]));
    expect(byLabel["0|"]).toBeDefined();
    expect(byLabel["0|https://widget.example.net/embed"]).toBeDefined();
  });
});
