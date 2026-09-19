import { describe, expect, it } from "vitest";
import {
  ageChip,
  ageSentence,
  describeRecord,
  interpretRdapResponse,
  isRecentRegistration,
  lookupDomain,
  lookupTarget,
  noRecordSentence,
  parseRdapDomain,
  rdapDisclosure,
  REGISTRATION_ATTRIBUTION,
  REGISTRATION_CAVEAT,
  unavailableSentence,
} from "../src/lib/domain-lookup";
import type { RdapFetch } from "../src/lib/domain-lookup";

/** The same rule the rest of this panel lives under: no output may read as a verdict. */
const REASSURANCE = /\b(safe|unsafe|secure|insecure|trusted|trustworthy|legitimate|verified|clean|malicious)\b/i;

const NOW = new Date("2026-09-19T12:00:00Z");

function rdapBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objectClassName: "domain",
    ldhName: "EXAMPLE.COM",
    status: ["client transfer prohibited", "server delete prohibited"],
    events: [
      { eventAction: "registration", eventDate: "1995-08-14T04:00:00Z" },
      { eventAction: "expiration", eventDate: "2027-08-13T04:00:00Z" },
      { eventAction: "last changed", eventDate: "2026-08-14T07:01:44Z" },
      { eventAction: "last update of RDAP database", eventDate: "2026-09-19T11:59:00Z" },
    ],
    entities: [
      {
        objectClassName: "entity",
        roles: ["registrar"],
        vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Some Registrar, Inc."]]],
      },
    ],
    ...overrides,
  };
}

describe("reading an RDAP domain record", () => {
  it("pulls the events, the registrar and the status out of a typical answer", () => {
    const record = parseRdapDomain(rdapBody(), "example.com", NOW);
    expect(record).not.toBeNull();
    expect(record?.name).toBe("example.com");
    expect(record?.registered).toBe("1995-08-14T04:00:00.000Z");
    expect(record?.expires).toBe("2027-08-13T04:00:00.000Z");
    expect(record?.registrar).toBe("Some Registrar, Inc.");
    expect(record?.statuses).toEqual(["client transfer prohibited", "server delete prohibited"]);
  });

  /** When the directory itself was refreshed is not when the domain changed. */
  it("does not read 'last update of RDAP database' as a change to the domain", () => {
    const record = parseRdapDomain(rdapBody(), "example.com", NOW);
    expect(record?.lastChanged).toBe("2026-08-14T07:01:44.000Z");
  });

  it("accepts the spellings other registries use", () => {
    const record = parseRdapDomain(
      rdapBody({ events: [{ eventAction: "Created", eventDate: "2026-09-13T00:00:00Z" }, { eventAction: "expiry", eventDate: "2027-09-13T00:00:00Z" }] }),
      "example.com",
      NOW,
    );
    expect(record?.registered).toBe("2026-09-13T00:00:00.000Z");
    expect(record?.expires).toBe("2027-09-13T00:00:00.000Z");
  });

  it("finds a registrar nested inside another entity", () => {
    const record = parseRdapDomain(
      rdapBody({
        entities: [
          {
            roles: ["registrant"],
            entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "Nested Registrar"]]] }],
          },
        ],
      }),
      "example.com",
      NOW,
    );
    expect(record?.registrar).toBe("Nested Registrar");
  });

  it("returns a record with empty fields rather than nothing when the registry is terse", () => {
    const record = parseRdapDomain({ objectClassName: "domain", ldhName: "sparse.example" }, "sparse.example", NOW);
    expect(record?.registered).toBeNull();
    expect(record?.registrar).toBeNull();
    expect(describeRecord(record!)).toEqual([]);
  });

  it("refuses anything that is not a domain record", () => {
    expect(parseRdapDomain({ objectClassName: "entity", handle: "x" }, "example.com", NOW)).toBeNull();
    expect(parseRdapDomain("<html>", "example.com", NOW)).toBeNull();
    expect(parseRdapDomain(null, "example.com", NOW)).toBeNull();
    expect(parseRdapDomain({ rubbish: true }, "example.com", NOW)).toBeNull();
  });

  it("ignores a date it cannot parse instead of inventing one", () => {
    const record = parseRdapDomain(rdapBody({ events: [{ eventAction: "registration", eventDate: "not a date" }] }), "example.com", NOW);
    expect(record?.registered).toBeNull();
    expect(record?.ageDays).toBeNull();
  });

  it("treats a registration date in the future as a broken record, not a new domain", () => {
    const record = parseRdapDomain(rdapBody({ events: [{ eventAction: "registration", eventDate: "2030-01-01T00:00:00Z" }] }), "example.com", NOW);
    expect(record?.ageDays).toBeNull();
    expect(ageSentence(record!)).toContain("broken record");
  });
});

describe("how an answer is classified", () => {
  it("calls a 404 a missing record, not a finding about the domain", () => {
    const lookup = interpretRdapResponse({ domain: "example.zw", status: 404, body: { errorCode: 404, title: "Not found" }, now: NOW });
    expect(lookup.state).toBe("no_record");
    expect(noRecordSentence("example.zw")).toContain("not about the domain");
    expect(noRecordSentence("example.zw")).not.toMatch(REASSURANCE);
  });

  it("calls a server error a failed lookup", () => {
    const lookup = interpretRdapResponse({ domain: "example.com", status: 503, body: null, now: NOW });
    expect(lookup.state).toBe("unavailable");
    expect(lookup.state === "unavailable" && lookup.detail).toContain("503");
  });

  it("names rate limiting for what it is", () => {
    const lookup = interpretRdapResponse({ domain: "example.com", status: 429, body: null, now: NOW });
    expect(lookup.state === "unavailable" && lookup.detail).toContain("rate-limiting");
  });

  it("does not present an unreadable 200 as a record", () => {
    const lookup = interpretRdapResponse({ domain: "example.com", status: 200, body: "<html>maintenance</html>", now: NOW });
    expect(lookup.state).toBe("unavailable");
  });

  it("reports a good answer as found", () => {
    const lookup = interpretRdapResponse({ domain: "example.com", status: 200, body: rdapBody(), now: NOW });
    expect(lookup.state).toBe("found");
  });
});

describe("what gets looked up", () => {
  it("asks about the registrable name, not the full hostname", () => {
    expect(lookupTarget("accounts.news.example.co.uk")).toBe("example.co.uk");
    expect(lookupTarget("EXAMPLE.COM.")).toBe("example.com");
  });

  it("has nothing to ask about for an address with no registered name", () => {
    expect(lookupTarget("192.168.1.1")).toBeNull();
    expect(lookupTarget("[::1]")).toBeNull();
    expect(lookupTarget("localhost")).toBeNull();
    expect(lookupTarget("")).toBeNull();
  });
});

describe("the request itself", () => {
  it("sends the name to rdap.org with no cookies and no referrer, and reads the answer", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: RdapFetch = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, json: async () => rdapBody() };
    };
    const lookup = await lookupDomain("www.example.com", { fetchImpl, now: NOW });
    expect(calls[0].url).toBe("https://rdap.org/domain/example.com");
    expect(calls[0].init.credentials).toBe("omit");
    expect(calls[0].init.referrerPolicy).toBe("no-referrer");
    expect(calls[0].init.redirect).toBe("follow");
    expect(lookup.state).toBe("found");
  });

  it("sends nothing at all when there is no registered name in the address", async () => {
    let called = false;
    const fetchImpl: RdapFetch = async () => {
      called = true;
      return { status: 200, json: async () => rdapBody() };
    };
    const lookup = await lookupDomain("10.0.0.7", { fetchImpl });
    expect(called).toBe(false);
    expect(lookup.state).toBe("not_a_domain");
  });

  it("turns a dead service into a failed lookup rather than a claim", async () => {
    const fetchImpl: RdapFetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    const lookup = await lookupDomain("example.com", { fetchImpl });
    expect(lookup.state).toBe("unavailable");
    expect(unavailableSentence("example.com", "the request failed")).toContain("says nothing about the domain");
  });

  it("survives a body that is not JSON", async () => {
    const fetchImpl: RdapFetch = async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    const lookup = await lookupDomain("example.com", { fetchImpl });
    expect(lookup.state).toBe("unavailable");
  });
});

describe("how the age is told", () => {
  const aged = (iso: string) => parseRdapDomain(rdapBody({ events: [{ eventAction: "registration", eventDate: iso }] }), "example.com", NOW)!;

  it("counts days for a name registered days ago", () => {
    const record = aged("2026-09-07T12:00:00Z");
    expect(record.ageDays).toBe(12);
    expect(ageSentence(record)).toBe("Registered 12 days ago, on 2026-09-07.");
    expect(ageChip(record)).toBe("registered 12 days ago");
    expect(isRecentRegistration(record)).toBe(true);
  });

  it("says today and yesterday in words", () => {
    expect(ageSentence(aged("2026-09-19T01:00:00Z"))).toBe("Registered today, 2026-09-19.");
    expect(ageSentence(aged("2026-09-18T01:00:00Z"))).toBe("Registered yesterday, 2026-09-18.");
  });

  it("moves to months and then years, keeping the date itself", () => {
    expect(ageSentence(aged("2026-01-19T12:00:00Z"))).toContain("months ago, on 2026-01-19");
    expect(ageSentence(aged("1995-08-14T04:00:00Z"))).toContain("years ago, on 1995-08-14");
  });

  it("stops drawing attention past the threshold without calling the domain anything", () => {
    expect(isRecentRegistration(aged("2020-01-01T00:00:00Z"))).toBe(false);
    expect(ageSentence(aged("2020-01-01T00:00:00Z"))).not.toMatch(REASSURANCE);
  });

  it("says when there is no date rather than guessing", () => {
    const record = parseRdapDomain({ objectClassName: "domain", ldhName: "x.example" }, "x.example", NOW)!;
    expect(ageSentence(record)).toBe("The record carries no registration date.");
    expect(ageChip(record)).toBe("age not in the record");
    expect(isRecentRegistration(record)).toBe(false);
  });
});

describe("what the reader is told", () => {
  it("names the third party and the registry before anything is sent", () => {
    const disclosure = rdapDisclosure("example.com");
    expect(disclosure).toContain("rdap.org");
    expect(disclosure).toContain("third party");
    expect(disclosure).toContain("registry");
    expect(disclosure).toContain("is not contacted");
  });

  it("attributes the answer to the network, not to the page", () => {
    expect(REGISTRATION_ATTRIBUTION).toContain("over the network");
    expect(REGISTRATION_ATTRIBUTION).toContain("not read from the page");
  });

  it("refuses to turn an age into a verdict", () => {
    expect(REGISTRATION_CAVEAT).not.toMatch(REASSURANCE);
    expect(REGISTRATION_CAVEAT).toContain("does not say who is behind it");
    expect(REGISTRATION_CAVEAT).toContain("changed hands");
  });

  it("keeps every sentence free of a stamp", () => {
    const everything = [
      rdapDisclosure("example.com"),
      REGISTRATION_ATTRIBUTION,
      REGISTRATION_CAVEAT,
      noRecordSentence("example.zw"),
      unavailableSentence("example.com", "the request failed"),
      ageSentence(parseRdapDomain(rdapBody(), "example.com", NOW)!),
    ].join(" ");
    expect(everything).not.toMatch(REASSURANCE);
  });

  it("produces no score or rating on any result", () => {
    const lookup = interpretRdapResponse({ domain: "example.com", status: 200, body: rdapBody(), now: NOW });
    expect(lookup).not.toHaveProperty("score");
    expect(lookup).not.toHaveProperty("rating");
    expect(lookup).not.toHaveProperty("verdict");
    expect(lookup.state === "found" && lookup.record).not.toHaveProperty("risk");
  });
});
