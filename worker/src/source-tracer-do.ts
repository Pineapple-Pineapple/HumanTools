import { Agent } from "agents";
import { BraveSearchClient } from "./brave-search";
import { BrowserbaseFetcher } from "./browserbase-fetch";
import { ElasticSourceIndex } from "./elastic-index";
import { rankCandidates } from "./source-candidates";
import { makeSourceTracer } from "./source-tracer-agent";
import type { Env, SourceTraceRequest } from "./types";

interface SourceTracerState {
  lastCompletedAt?: string;
  lastVerifiedSourceCount: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function isSourceTraceRequest(value: unknown): value is SourceTraceRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  const page = request.page as Record<string, unknown> | null;
  return (
    typeof request.claim === "string" &&
    typeof request.verifiedQuote === "string" &&
    typeof request.installId === "string" &&
    typeof page?.url === "string" &&
    typeof page?.title === "string"
  );
}

export class SourceTracerAgent extends Agent<Env, SourceTracerState> {
  initialState: SourceTracerState = { lastVerifiedSourceCount: 0 };

  /** Held on the agent rather than built per request, so the index mapping is checked once. */
  private elasticIndex?: ElasticSourceIndex;

  private get elastic(): ElasticSourceIndex {
    this.elasticIndex ??= new ElasticSourceIndex(this.env.ELASTIC_URL, this.env.ELASTIC_API_KEY);
    return this.elasticIndex;
  }

  async onRequest(request: Request): Promise<Response> {
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON." }, 400);
    }
    if (!isSourceTraceRequest(payload)) return json({ error: "Invalid source trace request." }, 400);

    const search = new BraveSearchClient(this.env.BRAVE_SEARCH_API_KEY);
    const browserbase = new BrowserbaseFetcher({
      apiKey: this.env.BROWSERBASE_API_KEY,
    });
    const elastic = this.elastic;
    const tracer = makeSourceTracer({
      recall: (input) => elastic.search(input.claim, input.verifiedQuote),
      search: async (input) => rankCandidates(await search.search(`${input.claim} "${input.verifiedQuote}"`)),
      fetch: (candidate) => browserbase.fetch(candidate),
      index: (source, quote) => elastic.index(source, quote),
    });

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();
    const write = (message: unknown) => writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
    const run = tracer
      .trace(payload, (event) => void write(event))
      .then(async (outcome) => {
        this.setState({ lastCompletedAt: new Date().toISOString(), lastVerifiedSourceCount: outcome.sources.length });
        await write({ type: "SOURCE_TRACE_DONE", sources: outcome.sources, contexts: outcome.contexts });
      })
      .catch(async () => {
        await write({ type: "SOURCE_TRACE_DONE", sources: [], contexts: [] });
      })
      .finally(() => writer.close());
    this.ctx.waitUntil(run);
    return new Response(stream.readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
  }
}
