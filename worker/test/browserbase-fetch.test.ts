import { afterEach, describe, expect, it } from "vitest";
import type { CandidateSource } from "../src/source-candidates";

const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = nativeFetch;
});

async function loadBrowserbase(): Promise<typeof import("../src/browserbase-fetch") | null> {
  try {
    return await import("../src/browserbase-fetch");
  } catch {
    return null;
  }
}

const candidate: CandidateSource = {
  url: "https://data.gov/release",
  title: "Official release",
  description: "",
  domainScore: 300,
};

describe("BrowserbaseFetcher", () => {
  it("calls the Worker fetch function with globalThis as its receiver", async () => {
    const module = await loadBrowserbase();
    expect(module).not.toBeNull();
    let receiver: unknown;
    globalThis.fetch = async function (this: unknown) {
      receiver = this;
      return Response.json({ id: "session-1", connectUrl: "wss://connect.browserbase.test/session-1" });
    };
    const fetcher = new module!.BrowserbaseFetcher({
      apiKey: "key",
      readDocument: async () => ({ title: "Official release", url: candidate.url, text: "Verified text." }),
    });

    await fetcher.fetch(candidate);

    expect(receiver).toBe(globalThis);
  });

  it("creates a Browserbase session, reads the document, and releases the session", async () => {
    const module = await loadBrowserbase();
    expect(module).not.toBeNull();
    const requests: Request[] = [];
    const fetcher = new module!.BrowserbaseFetcher({
      apiKey: "key",
      fetcher: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ id: "session-1", connectUrl: "wss://connect.browserbase.test/session-1" });
      },
      readDocument: async (connectUrl, targetUrl) => {
        expect(connectUrl).toBe("wss://connect.browserbase.test/session-1");
        expect(targetUrl).toBe(candidate.url);
        return {
          title: "Official release",
          url: candidate.url,
          text: "Revenue increased from $1 million to $4 million.",
        };
      },
    });

    await expect(fetcher.fetch(candidate)).resolves.toEqual({
      title: "Official release",
      url: candidate.url,
      text: "Revenue increased from $1 million to $4 million.",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].url).toBe("https://api.browserbase.com/v1/sessions");
    expect(await requests[0].json()).toEqual({ timeout: 60 });
    expect(requests[1].url).toBe("https://api.browserbase.com/v1/sessions/session-1");
  });

  it("releases the session when the document read throws", async () => {
    const module = await loadBrowserbase();
    expect(module).not.toBeNull();
    const requests: Request[] = [];
    const fetcher = new module!.BrowserbaseFetcher({
      apiKey: "key",
      fetcher: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ id: "session-1", connectUrl: "wss://connect.browserbase.test/session-1" });
      },
      readDocument: async () => {
        throw new Error("Browserbase returned no readable document.");
      },
    });

    await expect(fetcher.fetch(candidate)).rejects.toThrow("no readable document");
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.browserbase.com/v1/sessions",
      "https://api.browserbase.com/v1/sessions/session-1",
    ]);
    expect(await requests[1].json()).toEqual({ status: "REQUEST_RELEASE" });
  });

  it("aborts a read that outlives its budget and still releases the session", async () => {
    const module = await loadBrowserbase();
    expect(module).not.toBeNull();
    const released: string[] = [];
    const fetcher = new module!.BrowserbaseFetcher({
      apiKey: "key",
      timeoutMs: 20,
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/sessions/session-1")) released.push(request.url);
        return Response.json({ id: "session-1", connectUrl: "wss://connect.browserbase.test/session-1" });
      },
      readDocument: (_connectUrl, _targetUrl, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    });

    await expect(fetcher.fetch(candidate)).rejects.toThrow("Browserbase fetch timed out.");
    expect(released).toEqual(["https://api.browserbase.com/v1/sessions/session-1"]);
  });

  it("retries a transient document read once", async () => {
    const module = await loadBrowserbase();
    expect(module).not.toBeNull();
    let reads = 0;
    const fetcher = new module!.BrowserbaseFetcher({
      apiKey: "key",
      fetcher: async () => Response.json({ id: "session-1", connectUrl: "wss://connect.browserbase.test/session-1" }),
      readDocument: async () => {
        reads++;
        if (reads === 1) throw new module!.TransientBrowserbaseError("connection closed");
        return { title: "Official release", url: candidate.url, text: "Verified text." };
      },
    });

    await expect(fetcher.fetch(candidate)).resolves.toMatchObject({ url: candidate.url });
    expect(reads).toBe(2);
  });
});
