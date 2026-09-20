import { describe, expect, it } from "vitest";
import {
  buildApplicationReport,
  classifyField,
  contrastRatio,
  detectGates,
  detectScarcity,
  findDeemphasisedExits,
  groupRequestedData,
  isConfirmshaming,
  matchKnownTracker,
  registrableDomain,
  summarizeThirdParties,
} from "../src/lib/application-heuristics";
import type { RawApplicationSignals, RawControl, RawFormField } from "../src/lib/application-heuristics";

function field(overrides: Partial<RawFormField> = {}): RawFormField {
  return {
    tag: "input",
    type: "text",
    name: "",
    id: "",
    autocomplete: "",
    placeholder: "",
    ariaLabel: "",
    label: "",
    required: false,
    ...overrides,
  };
}

function control(overrides: Partial<RawControl> = {}): RawControl {
  return {
    text: "",
    kind: "button",
    fontSizePx: 16,
    color: "rgb(0, 0, 0)",
    background: "rgb(255, 255, 255)",
    positionRatio: 0.3,
    ...overrides,
  };
}

function signals(overrides: Partial<RawApplicationSignals> = {}): RawApplicationSignals {
  return {
    url: "https://example.com/page",
    title: "Example",
    fields: [],
    formCount: 0,
    resources: [],
    checkboxes: [],
    controls: [],
    textLines: [],
    overlays: [],
    scrollLocked: false,
    cookieCount: 0,
    cookieNames: [],
    localStorageKeys: 0,
    sessionStorageKeys: 0,
    storageNote: "",
    permissions: [],
    crossOriginFrames: 0,
    truncated: [],
    ...overrides,
  };
}

describe("classifyField", () => {
  it("names the concrete thing a field collects", () => {
    expect(classifyField(field({ type: "password" }))).toBe("password");
    expect(classifyField(field({ type: "email" }))).toBe("email");
    expect(classifyField(field({ autocomplete: "tel" }))).toBe("phone");
    expect(classifyField(field({ label: "Date of birth" }))).toBe("date_of_birth");
    expect(classifyField(field({ name: "postcode" }))).toBe("postal_address");
    expect(classifyField(field({ placeholder: "Social Security Number" }))).toBe("government_id");
  });

  it("reads a cardholder name as payment, not as a name", () => {
    expect(classifyField(field({ autocomplete: "cc-name", label: "Name on card" }))).toBe("payment_card");
    expect(classifyField(field({ label: "First name" }))).toBe("full_name");
  });

  it("ignores inputs that collect nothing about the reader", () => {
    expect(classifyField(field({ type: "search", ariaLabel: "Search this site" }))).toBeNull();
    expect(classifyField(field({ type: "hidden", name: "email" }))).toBeNull();
    expect(classifyField(field({ type: "submit", name: "go" }))).toBeNull();
    expect(classifyField(field({ name: "quantity" }))).toBeNull();
  });
});

describe("groupRequestedData", () => {
  it("groups fields by what they collect and leads with the most revealing", () => {
    const groups = groupRequestedData([
      field({ type: "email", label: "Email address" }),
      field({ type: "email", name: "confirm_email", label: "Confirm email" }),
      field({ placeholder: "Passport number" }),
    ]);

    expect(groups.map((g) => g.category)).toEqual(["government_id", "email"]);
    expect(groups[1].fields).toEqual(["Email address", "Confirm email"]);
  });

  it("returns nothing when a page only has a search box", () => {
    expect(groupRequestedData([field({ type: "search", label: "Search" })])).toEqual([]);
  });
});

describe("third parties", () => {
  it("approximates the registrable domain, including two-part suffixes", () => {
    expect(registrableDomain("www.google-analytics.com")).toBe("google-analytics.com");
    expect(registrableDomain("static.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("example.com")).toBe("example.com");
  });

  it("drops first-party resources and puts recognised names first", () => {
    const parties = summarizeThirdParties(
      [
        { kind: "script", url: "https://cdn.example.com/app.js" },
        { kind: "script", url: "https://cdn.jsdelivr.net/lib.js" },
        { kind: "script", url: "https://www.google-analytics.com/analytics.js" },
        { kind: "pixel", url: "https://www.facebook.com/tr?id=1" },
      ],
      "https://example.com/page",
    );

    // Recognised names first, then by how many resources they serve, then alphabetically.
    expect(parties.map((p) => p.domain)).toEqual(["facebook.com", "google-analytics.com", "jsdelivr.net"]);
    expect(parties[1].tracker?.category).toBe("analytics");
    expect(parties[2].tracker).toBeUndefined();
  });

  it("only claims a match for domains actually on the list", () => {
    expect(matchKnownTracker("hotjar.com")?.category).toBe("session_recording");
    expect(matchKnownTracker("some-tracker-we-never-heard-of.com")).toBeUndefined();
  });
});

describe("confirmshaming", () => {
  it("flags a decline written as self-criticism", () => {
    expect(isConfirmshaming("No thanks, I'd rather pay full price")).toBe(true);
    expect(isConfirmshaming("No thanks, I don't want to save money")).toBe(true);
    expect(isConfirmshaming("I'll pass — I prefer to stay uninformed")).toBe(true);
  });

  it("leaves a plain decline alone", () => {
    expect(isConfirmshaming("No thanks")).toBe(false);
    expect(isConfirmshaming("Decline")).toBe(false);
    expect(isConfirmshaming("Unsubscribe from this newsletter")).toBe(false);
    expect(isConfirmshaming("Accept all cookies")).toBe(false);
  });
});

describe("scarcity and gates", () => {
  it("separates stock claims, countdowns and crowd claims", () => {
    const hits = detectScarcity([
      "Only 3 left in stock",
      "Offer ends in 02:14:09",
      "17 people are viewing this right now",
      "Free shipping on orders over $50",
    ]);

    expect(hits.map((h) => h.kind)).toEqual(["stock", "countdown", "social_proof"]);
    expect(hits[0].line).toBe("Only 3 left in stock");
  });

  it("finds account walls and paywalls by their wording", () => {
    const gates = detectGates(["Sign in to continue reading", "Subscribe to read the rest", "Our newsletter is free"]);
    expect(gates.map((g) => g.label)).toEqual(["Account wall", "Paywall"]);
  });
});

describe("contrast and de-emphasised exits", () => {
  it("computes WCAG contrast, and refuses to guess at an unparseable colour", () => {
    expect(contrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)")).toBe(21);
    expect(contrastRatio("rgb(255, 255, 255)", "rgb(255, 255, 255)")).toBe(1);
    expect(contrastRatio("currentColor", "rgb(255, 255, 255)")).toBeNull();
  });

  it("measures how the way out compares with the accept action", () => {
    const hits = findDeemphasisedExits([
      control({ text: "Accept all", fontSizePx: 16, positionRatio: 0.2 }),
      control({
        text: "Manage preferences",
        kind: "link",
        fontSizePx: 10,
        color: "rgb(200, 200, 200)",
        positionRatio: 0.96,
      }),
    ]);

    expect(hits).toHaveLength(1);
    expect(hits[0].reasons).toHaveLength(3);
    expect(hits[0].reasons[0]).toContain("10px text against 16px");
    expect(hits[0].reasons[1]).toContain("contrast 1.7:1");
    expect(hits[0].reasons[2]).toContain("96%");
  });

  it("says nothing when the way out is as prominent as the accept action", () => {
    expect(
      findDeemphasisedExits([
        control({ text: "Accept all", fontSizePx: 16, positionRatio: 0.2 }),
        control({ text: "Reject all", fontSizePx: 16, positionRatio: 0.2 }),
      ]),
    ).toEqual([]);
  });
});

describe("buildApplicationReport", () => {
  it("reports an ordinary page with nothing to flag as nothing found, never as safe", () => {
    const report = buildApplicationReport(signals());

    expect(report.findingCount).toBe(0);
    expect(report.host).toBe("example.com");
    expect(report.sections.map((s) => s.id)).toEqual(["requested-data", "third-parties", "pressure", "storage"]);
    for (const section of report.sections) {
      expect(section.findings).toEqual([]);
      expect(section.emptyNote.length).toBeGreaterThan(0);
    }
    expect(report.notChecked.length).toBeGreaterThan(3);
    expect(JSON.stringify(report)).not.toMatch(/\bsafe\b|\bno trackers\b|\bclean\b/i);
  });

  it("labels a hand-written domain match as a pattern and a pre-ticked box as observed", () => {
    const report = buildApplicationReport(
      signals({
        resources: [{ kind: "script", url: "https://www.googletagmanager.com/gtm.js" }],
        checkboxes: [
          { defaultChecked: true, checked: true, label: "Email me offers and updates", name: "marketing" },
          { defaultChecked: true, checked: true, label: "Keep me signed in", name: "remember" },
          { defaultChecked: false, checked: false, label: "I agree to the terms", name: "tos" },
        ],
      }),
    );

    const findings = report.sections.flatMap((s) => s.findings);
    const trackers = findings.find((f) => f.id === "third-parties-known");
    const marketing = findings.find((f) => f.id === "prechecked-marketing");
    const plain = findings.find((f) => f.id === "prechecked");

    expect(trackers?.basis).toBe("pattern");
    expect(trackers?.evidence[0].text).toContain("Google Tag Manager");
    expect(marketing?.basis).toBe("pattern");
    expect(marketing?.evidence).toEqual([{ text: "Email me offers and updates" }]);
    // The unticked consent box is not a finding — only what the page decided for you is.
    expect(plain?.evidence).toEqual([{ text: "Keep me signed in" }]);
  });

  it("says what it could not see when frames are cross-origin or a permission name is unknown", () => {
    const report = buildApplicationReport(
      signals({ crossOriginFrames: 2, permissions: [{ name: "camera", state: "unsupported" }] }),
    );

    expect(report.notChecked.map((entry) => entry.detail).join(" ")).toContain("2 frames");
    expect(report.notChecked.map((entry) => entry.detail).join(" ")).toContain("camera");
  });
});
