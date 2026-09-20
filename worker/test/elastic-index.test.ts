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

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const source = {
  title: "Official release",
  url: "https://data.gov/release",
  excerpt: "Revenue increased from $1 million to $4 million.",
  publisher: "data.gov",
  verifiedAt: "2026-09-19T12:00:00.000Z",
  sourceQuality: "institutional_signal" as const,
};
const quote = "revenue increased from $1 million to $4 million";

/** The mapping call every operation makes first; tests care about what follows it. */
function afterSetup(requests: readonly Request[]): Request[] {
  return requests.filter((request) => !request.url.endsWith("/human-tools-sources"));
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

    await new module!.ElasticSourceIndex("https://elastic.test/", "api-key").index(source, quote);

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

    await index.index(source, quote);

    const documents = afterSetup(requests);
    expect(documents).toHaveLength(1);
    expect(documents[0].method).toBe("PUT");
    expect(documents[0].headers.get("Authorization")).toBe("ApiKey api-key");
    const document = await documents[0].json() as Record<string, unknown>;
    expect(document).toMatchObject({
      url: "https://data.gov/release",
      excerpt: "Revenue increased from $1 million to $4 million.",
      verification: "verified",
    });
    expect(document).not.toHaveProperty("text");
  });

  it("creates the index mapping once and treats an existing index as success", async () => {
    const module = await loadElasticIndex();
    expect(module).not.toBeNull();
    const requests: Request[] = [];
    const index = new module!.ElasticSourceIndex("https://elastic.test/", "api-key", async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/human-tools-sources")) {
        return new Response('{"error":{"type":"resource_already_exists_exception"}}', { status: 400 });
      }
      return Response.json({ result: "updated" });
    });

    await index.index(source, quote);
    await index.index(source, quote);

    const setups = requests.filter((request) => request.url.endsWith("/human-tools-sources"));
    expect(setups).toHaveLength(1);
    const mapping = await setups[0].json() as { mappings: { properties: Record<string, { type: string }> } };
    expect(mapping.mappings.properties.excerptSemantic.type).toBe("semantic_text");
    expect(afterSetup(requests)).toHaveLength(2);
  });

  it("searches with BM25 and semantic retrievers fused and reranked", async () => {
    const module = await loadElasticIndex();
    expect(module).not.toBeNull();
    const requests: Request[] = [];
    const index = new module!.ElasticSourceIndex("https://elastic.test/", "api-key", async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("/human-tools-sources")) return Response.json({ acknowledged: true });
      return Response.json({
        hits: { hits: [{ _score: 9.1, _source: { ...source, claimHash: await sha256(quote) } }] },
      });
    });

    const recalled = await index.search("Revenue rose substantially.", quote);

    const searches = afterSetup(requests);
    expect(searches).toHaveLength(1);
    expect(searches[0].method).toBe("POST");
    const body = await searches[0].json() as Record<string, any>;
    const fused = body.retriever.text_similarity_reranker.retriever.rrf.retrievers;
    expect(fused[0].standard.query.multi_match.fields).toEqual(["excerpt^2", "title"]);
    expect(fused[1].standard.query.semantic.field).toBe("excerptSemantic");
    expect(recalled).toEqual([
      { source, exact: true, score: 9.1 },
    ]);
  });

  it("marks a hit recorded against a different quote as a lead rather than a verification", async () => {
    const module = await loadElasticIndex();
    expect(module).not.toBeNull();
    const index = new module!.ElasticSourceIndex("https://elastic.test/", "api-key", async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/human-tools-sources")) return Response.json({ acknowledged: true });
      return Response.json({
        hits: { hits: [{ _score: 4, _source: { ...source, claimHash: await sha256("a different quote entirely") } }] },
      });
    });

    const recalled = await index.search("Revenue rose substantially.", quote);

    expect(recalled).toEqual([{ source, exact: false, score: 4 }]);
  });

  it("drops the reranker and retries when the cluster has no rerank endpoint", async () => {
    const module = await loadElasticIndex();
    expect(module).not.toBeNull();
    const bodies: Record<string, any>[] = [];
    const index = new module!.ElasticSourceIndex("https://elastic.test/", "api-key", async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/human-tools-sources")) return Response.json({ acknowledged: true });
      const body = await request.json() as Record<string, any>;
      bodies.push(body);
      if (body.retriever.text_similarity_reranker) {
        return new Response('{"error":{"type":"resource_not_found_exception"}}', { status: 404 });
      }
      return Response.json({ hits: { hits: [] } });
    });

    await expect(index.search("Revenue rose substantially.", quote)).resolves.toEqual([]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].retriever.rrf).toBeDefined();
    expect(bodies[1].retriever.text_similarity_reranker).toBeUndefined();

    // The second search already knows the endpoint is missing and does not pay for the rejection.
    await index.search("Another claim.", quote);
    expect(bodies).toHaveLength(3);
    expect(bodies[2].retriever.rrf).toBeDefined();
  });
});
