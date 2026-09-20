import { describe, expect, it } from "vitest";
import {
  describeDestination,
  destinationSentence,
  resolvableLinks,
  resolveDisclosure,
  resolveLink,
  RESOLVE_ATTRIBUTION,
  RESOLVE_DISCLOSURE,
} from "../src/lib/link-resolver";
import type { ResolverFetch } from "../src/lib/link-resolver";
import type { LinkSignal, SecuritySignals } from "../src/lib/security-heuristics";

/** The same rule the rest of this panel lives under: no output may read as a verdict. */
const REASSURANCE = /\b(safe|unsafe|secure|insecure|trusted|trustworthy|legitimate|verified|clean|malicious)\b/i;

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

/** A fetch that answers from a script and records what it was asked, so the request shape is checked too. */
function scriptedFetch(answers: ((method: string) => { url: string; status: number } | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: ResolverFetch = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error("no more scripted answers");
    const answer = next(String(init.method));
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetchImpl, calls };
}

describe("which links are offered a button", () => {
  it("offers only the links the scan had something to say about", () => {
    const flagged = resolvableLinks(
      signals({
        links: [
          link({ text: "Contact" }),
          link({ text: "yourbank.com", href: "https://secure-login.cc/x", hostname: "secure-login.cc" }),
          link({ href: "https://xn--pypal-4ve.com/", hostname: "xn--pypal-4ve.com" }),
          link({ href: "https://bit.ly/abc", hostname: "bit.ly" }),
          link({ text: "example.org", href: "https://t.example.net/?u=https://example.org/p", hostname: "t.example.net" }),
        ],
      }),
    );
    expect(flagged.map((entry) => entry.reason)).toEqual(["text_mismatch", "punycode", "shortener", "wrapped"]);
    expect(flagged.every((entry) => entry.frameUrl === "")).toBe(true);
  });

  it("skips links that are not web addresses, whatever their text claims", () => {
    const flagged = resolvableLinks(
      signals({ links: [link({ text: "paypal.com", href: "mailto:x@y.com", hostname: "", protocol: "mailto:" })] }),
    );
    expect(flagged).toEqual([]);
  });

  it("lists one href once, under the reason that matters more", () => {
    const flagged = resolvableLinks(
      signals({
        links: [
          link({ text: "Details", href: "https://bit.ly/abc", hostname: "bit.ly" }),
          link({ text: "yourbank.com", href: "https://bit.ly/abc", hostname: "bit.ly" }),
        ],
      }),
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0].reason).toBe("text_mismatch");
    expect(flagged[0].text).toBe("yourbank.com");
  });

  it("says which frame a flagged link came from", () => {
    const frame = signals({
      url: "https://widget.example.net/embed",
      origin: "https://widget.example.net",
      hostname: "widget.example.net",
      links: [link({ href: "https://bit.ly/abc", hostname: "bit.ly" })],
    });
    const flagged = resolvableLinks(signals(), [frame]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].frameUrl).toBe("https://widget.example.net/embed");
  });
});

describe("describing where a request stopped", () => {
  it("says a link ends where it points when nothing redirected", () => {
    const resolution = describeDestination("https://example.com/a", "https://example.com/a", 200, "HEAD");
    expect(resolution).toMatchObject({ state: "resolved", sameUrl: true, movedSite: false });
    expect(destinationSentence(resolution)).toBe("It ends where it points: https://example.com/a. Nothing redirected. HTTP 200 to a HEAD request.");
  });

  it("names a move to a different registered name", () => {
    const resolution = describeDestination("https://bit.ly/abc", "https://www.example.org/story", 200, "HEAD");
    expect(resolution).toMatchObject({ movedSite: true, sameUrl: false });
    expect(destinationSentence(resolution)).toContain("example.org, a different registered name from bit.ly");
  });

  it("says a redirect within one site stayed on it", () => {
    const resolution = describeDestination("https://example.com/a", "https://www.example.com/b", 301, "GET");
    expect(resolution).toMatchObject({ movedSite: false, sameUrl: false });
    expect(destinationSentence(resolution)).toBe("It ends at https://www.example.com/b, still on example.com. HTTP 301 to a GET request.");
  });

  it("falls back to the requested address when the response carries none", () => {
    const resolution = describeDestination("https://example.com/a", "", 200, "HEAD");
    expect(resolution).toMatchObject({ final: "https://example.com/a", sameUrl: true });
  });
});

describe("following a link", () => {
  it("refuses anything that is not an http or https address without touching the network", async () => {
    const { fetchImpl, calls } = scriptedFetch([]);
    const resolution = await resolveLink("javascript:void(0)", { fetchImpl });
    expect(resolution).toEqual({ state: "not_a_web_url", requested: "javascript:void(0)" });
    expect(calls).toHaveLength(0);
    expect(destinationSentence(resolution)).toContain("nothing to follow");
  });

  it("sends one HEAD with no cookies and no referrer, and stops there when it is answered", async () => {
    const { fetchImpl, calls } = scriptedFetch([() => ({ url: "https://www.example.org/x", status: 200 })]);
    const resolution = await resolveLink("https://bit.ly/abc", { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://bit.ly/abc");
    expect(calls[0].init).toMatchObject({ method: "HEAD", redirect: "follow", credentials: "omit", referrerPolicy: "no-referrer" });
    expect(resolution).toMatchObject({ state: "resolved", method: "HEAD", final: "https://www.example.org/x", movedSite: true });
  });

  it("falls back to GET when the server refuses the verb, and says so in the result", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      () => ({ url: "https://bit.ly/abc", status: 405 }),
      () => ({ url: "https://www.example.org/x", status: 200 }),
    ]);
    const resolution = await resolveLink("https://bit.ly/abc", { fetchImpl });

    expect(calls.map((call) => call.init.method)).toEqual(["HEAD", "GET"]);
    expect(resolution).toMatchObject({ state: "resolved", method: "GET", httpStatus: 200 });
  });

  it("does not retry with GET when HEAD answered with an ordinary error", async () => {
    const { fetchImpl, calls } = scriptedFetch([() => ({ url: "https://bit.ly/abc", status: 404 })]);
    const resolution = await resolveLink("https://bit.ly/abc", { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(resolution).toMatchObject({ state: "resolved", method: "HEAD", httpStatus: 404 });
  });

  it("tries GET when HEAD fails outright, and reports both failures if GET fails too", async () => {
    const { fetchImpl, calls } = scriptedFetch([() => new Error("Failed to fetch"), () => new Error("Failed to fetch")]);
    const resolution = await resolveLink("https://bit.ly/abc", { fetchImpl });

    expect(calls.map((call) => call.init.method)).toEqual(["HEAD", "GET"]);
    expect(resolution.state).toBe("failed");
    if (resolution.state === "failed") {
      expect(resolution.detail).toBe("the request failed (Failed to fetch), and then the request failed (Failed to fetch)");
    }
    expect(destinationSentence(resolution)).toContain("a fact about the request, not about where the link goes");
  });

  it("names a timeout in seconds", async () => {
    const timeout = new DOMException("The operation timed out", "TimeoutError");
    const { fetchImpl } = scriptedFetch([() => timeout, () => timeout]);
    const resolution = await resolveLink("https://bit.ly/abc", { fetchImpl, timeoutMs: 3000 });
    expect(resolution.state).toBe("failed");
    if (resolution.state === "failed") expect(resolution.detail).toContain("within 3 seconds");
  });
});

describe("what the reader is told", () => {
  it("says before the button what each press sends, to whom, and that it may be two requests", () => {
    expect(RESOLVE_DISCLOSURE).toContain("your own IP address");
    expect(RESOLVE_DISCLOSURE).toContain("second time");
    expect(RESOLVE_DISCLOSURE).toContain("No cookies");
    expect(RESOLVE_DISCLOSURE).toContain("hops in between cannot be read");
    expect(resolveDisclosure("https://bit.ly/abc")).toBe("Contacts bit.ly directly from your IP address.");
    expect(resolveDisclosure("not a url")).toBe("Contacts this address directly from your IP address.");
  });

  it("attributes the answer to the network, not to the page", () => {
    expect(RESOLVE_ATTRIBUTION).toContain("over the network");
    expect(RESOLVE_ATTRIBUTION).toContain("not from the page");
  });

  it("keeps every sentence free of a stamp", () => {
    const everything = [
      RESOLVE_DISCLOSURE,
      RESOLVE_ATTRIBUTION,
      resolveDisclosure("https://bit.ly/abc"),
      destinationSentence(describeDestination("https://bit.ly/abc", "https://www.example.org/x", 200, "HEAD")),
      destinationSentence(describeDestination("https://example.com/a", "https://example.com/a", 200, "HEAD")),
      destinationSentence({ state: "failed", requested: "https://bit.ly/abc", detail: "the request failed" }),
      destinationSentence({ state: "not_a_web_url", requested: "mailto:x@y" }),
    ].join(" ");
    expect(everything).not.toMatch(REASSURANCE);
  });
});
