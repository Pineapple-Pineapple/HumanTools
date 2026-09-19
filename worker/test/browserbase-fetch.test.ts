import { describe, expect, it } from "vitest";
import type { CandidateSource } from "../src/source-candidates";

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
  it("creates a Browserbase session, reads the document, and releases the session", async () => {
    const module = await loadBrowserbase();
    expect(module).not.toBeNull();
    const requests: Request[] = [];
    const fetcher = new module!.BrowserbaseFetcher({
      apiKey: "key",
      projectId: "project",
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
    expect(await requests[0].json()).toEqual({ projectId: "project", timeout: 60 });
    expect(requests[1].url).toBe("https://api.browserbase.com/v1/sessions/session-1");
  });

  it("retries a transient document read once", async () => {
    const module = await loadBrowserbase();
    expect(module).not.toBeNull();
    let reads = 0;
    const fetcher = new module!.BrowserbaseFetcher({
      apiKey: "key",
      projectId: "project",
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
