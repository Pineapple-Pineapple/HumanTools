import { Agent } from "agents";
import { BraveSearchClient, searchQuery } from "./brave-search";
import { BrowserbaseFetcher } from "./browserbase-fetch";
import { ElasticSourceIndex } from "./elastic-index";
import { rateLimitPolicy, takeRateLimitToken, type RateLimitWindow } from "./rate-limit";
import { rankCandidates } from "./source-candidates";
import { makeSourceTracer } from "./source-tracer-agent";
import { readTraceRequest } from "./trace-request";
import type { Env } from "./types";

const RATE_LIMIT_KEY = "rateLimit";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export class SourceTracerAgent extends Agent<Env> {
  /** Held on the agent rather than built per request, so the index mapping is checked once. */
  private elasticIndex?: ElasticSourceIndex;

  /** The index is memory, not the record: a missing configuration costs recall and indexing, never the trace. */
  private get elastic(): ElasticSourceIndex {
    if (!this.env.ELASTIC_URL || !this.env.ELASTIC_API_KEY) throw new Error("Elastic is not configured.");
    this.elasticIndex ??= new ElasticSourceIndex(this.env.ELASTIC_URL, this.env.ELASTIC_API_KEY);
    return this.elasticIndex;
  }

  async onRequest(request: Request): Promise<Response> {
    const parsed = await readTraceRequest(request);
    if (!parsed.ok) return json({ error: parsed.error }, 400);
    const payload = parsed.request;

    // Storage awaits hold the input gate, so the read-then-write is atomic against other requests.
    const decision = takeRateLimitToken(await this.ctx.storage.get<RateLimitWindow>(RATE_LIMIT_KEY), Date.now(), rateLimitPolicy(this.env));
    if (!decision.allowed) {
      return json({ error: "Too many source traces from this install." }, 429, { "retry-after": String(decision.retryAfterSeconds) });
    }
    await this.ctx.storage.put(RATE_LIMIT_KEY, decision.window);

    const search = new BraveSearchClient(this.env.BRAVE_SEARCH_API_KEY);
    const browserbase = new BrowserbaseFetcher({ apiKey: this.env.BROWSERBASE_API_KEY });
    const tracer = makeSourceTracer({
      recall: async (input) => this.elastic.search(input.claim, input.verifiedQuote),
      search: async (input) => rankCandidates(await search.search(searchQuery(input.claim, input.verifiedQuote))),
      fetch: (candidate) => browserbase.fetch(candidate),
      index: async (source, quote) => this.elastic.index(source, quote),
    });

    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();
    // A reader that has gone makes every write reject. The trace still runs to its end so sources
    // already paid for are indexed, but nothing is written to the dead stream again.
    let readerGone = false;
    const write = async (message: unknown): Promise<void> => {
      if (readerGone) return;
      try {
        await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
      } catch {
        readerGone = true;
      }
    };
    const run = tracer
      .trace(payload, (event) => void write(event))
      .then((outcome) => write({ type: "SOURCE_TRACE_DONE", sources: outcome.sources, contexts: outcome.contexts }))
      .catch((error: unknown) => {
        console.error("Source trace failed.", error);
        return write({ type: "SOURCE_TRACE_DONE", sources: [], contexts: [] });
      })
      .finally(() => writer.close().catch(() => {}));
    this.ctx.waitUntil(run);
    return new Response(stream.readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
  }
}
