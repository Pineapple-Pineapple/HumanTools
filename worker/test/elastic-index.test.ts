import { afterEach, describe, expect, it } from "vitest";

const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = nativeFetch;
});

async function loadElasticIndex(): Promise<typeof import("../src/elastic-index") | null> {
  try {
    return await import("../src/elastic-index");
  } catch {
    return null;
  }
}

describe("ElasticSourceIndex", () => {
  it("calls the Worker fetch function with globalThis as its receiver", async () => {
    const module = await loadElasticIndex();
    expect(module).not.toBeNull();
    let receiver: unknown;
    globalThis.fetch = async function (this: unknown) {
      receiver = this;
      return Response.json({ result: "created" });
    };

    await new module!.ElasticSourceIndex("https://elastic.test/", "api-key").index({
      title: "Official release",
      url: "https://data.gov/release",
      excerpt: "Revenue increased from $1 million to $4 million.",
      publisher: "data.gov",
      verifiedAt: "2026-09-19T12:00:00.000Z",
      sourceQuality: "institutional_signal",
    }, "revenue increased from $1 million to $4 million");

    expect(receiver).toBe(globalThis);
  });

  it("indexes only the verified excerpt rather than the full source page", async () => {
    const module = await loadElasticIndex();
    expect(module).not.toBeNull();
    const requests: Request[] = [];
    const index = new module!.ElasticSourceIndex("https://elastic.test/", "api-key", async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ result: "created" });
    });

    await index.index({
      title: "Official release",
      url: "https://data.gov/release",
      excerpt: "Revenue increased from $1 million to $4 million.",
      publisher: "data.gov",
      verifiedAt: "2026-09-19T12:00:00.000Z",
      sourceQuality: "institutional_signal",
    }, "revenue increased from $1 million to $4 million");

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("PUT");
    expect(requests[0].headers.get("Authorization")).toBe("ApiKey api-key");
    const document = await requests[0].json() as Record<string, unknown>;
    expect(document).toMatchObject({
      url: "https://data.gov/release",
      excerpt: "Revenue increased from $1 million to $4 million.",
      verification: "verified",
    });
    expect(document).not.toHaveProperty("text");
  });
});
