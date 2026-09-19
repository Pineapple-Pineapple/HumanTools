import type { FetchedSource } from "./browserbase-fetch";
import type { VerifiedSource } from "./elastic-index";
import { classifySourceContext, sourceQuality, type CandidateSource, type SourceContextReason } from "./source-candidates";
import { verifySourceExcerpt } from "./source-verify";
import type { SourceTraceRequest } from "./types";

export type TraceState = "running" | "done" | "skipped" | "failed";

export interface SourceTraceEvent {
  type: "SOURCE_TRACE";
  step: "Source search" | "Source fetch" | "Source verifier" | "Source index";
  state: TraceState;
  detail?: string;
  ms?: number;
}

export type TracedSource = VerifiedSource & { verification: "verified" };
export type ContextSource = VerifiedSource & { verification: "context"; contextReasons: SourceContextReason[] };

export interface SourceTracerDependencies {
  search: (request: SourceTraceRequest) => Promise<CandidateSource[]>;
  fetch: (candidate: CandidateSource) => Promise<FetchedSource>;
  index: (source: TracedSource, verifiedQuote: string) => Promise<void>;
}

export interface SourceTraceOutcome {
  sources: TracedSource[];
  contexts: ContextSource[];
  trace: SourceTraceEvent[];
}

function contextDetail(reasons: readonly SourceContextReason[]): string {
  return reasons.map((reason) => reason === "page_context" ? "Page context only." : "Known non-factual publisher.").join(" ");
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown source";
  }
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export function makeSourceTracer(
  dependencies: SourceTracerDependencies,
): { trace: (request: SourceTraceRequest, onTrace?: (event: SourceTraceEvent) => void) => Promise<SourceTraceOutcome> } {
  return {
    async trace(request, onTrace): Promise<SourceTraceOutcome> {
      const trace: SourceTraceEvent[] = [];
      const report = (step: SourceTraceEvent["step"], state: TraceState, detail?: string, ms?: number) => {
        const event = { type: "SOURCE_TRACE" as const, step, state, detail, ms };
        trace.push(event);
        onTrace?.(event);
      };

      report("Source search", "running");
      const searchStarted = Date.now();
      let candidates: CandidateSource[];
      try {
        candidates = await dependencies.search(request);
        report("Source search", "done", `${candidates.length} candidates`, Date.now() - searchStarted);
      } catch (error) {
        report("Source search", "failed", error instanceof Error ? error.message : "Search failed.", Date.now() - searchStarted);
        return { sources: [], contexts: [], trace };
      }

      const inspected = await mapWithConcurrency(candidates, 2, async (candidate): Promise<TracedSource | ContextSource | null> => {
        report("Source fetch", "running", host(candidate.url));
        const fetchStarted = Date.now();
        let fetched: FetchedSource;
        try {
          fetched = await dependencies.fetch(candidate);
          report("Source fetch", "done", host(fetched.url), Date.now() - fetchStarted);
        } catch (error) {
          report("Source fetch", "failed", error instanceof Error ? error.message : "Fetch failed.", Date.now() - fetchStarted);
          return null;
        }

        report("Source verifier", "running", host(fetched.url));
        const excerpt = verifySourceExcerpt(fetched.text, request.verifiedQuote);
        if (!excerpt || !fetched.url.startsWith("https://")) {
          report("Source verifier", "skipped", "No matching source excerpt.");
          return null;
        }
        const contextReasons = classifySourceContext(fetched.url, request.page.url);
        if (contextReasons.length) {
          report("Source verifier", "skipped", contextDetail(contextReasons));
          return {
            title: fetched.title,
            url: fetched.url,
            excerpt: excerpt.excerpt,
            publisher: host(fetched.url),
            verifiedAt: new Date().toISOString(),
            sourceQuality: sourceQuality(fetched.url),
            verification: "context",
            contextReasons,
          };
        }
        report("Source verifier", "done", host(fetched.url));
        return {
          title: fetched.title,
          url: fetched.url,
          excerpt: excerpt.excerpt,
          publisher: host(fetched.url),
          verifiedAt: new Date().toISOString(),
          sourceQuality: sourceQuality(fetched.url),
          verification: "verified",
        };
      });

      const sources = inspected.filter((source): source is TracedSource => source?.verification === "verified");
      const contexts = inspected.filter((source): source is ContextSource => source?.verification === "context");
      if (sources.length === 0) {
        report("Source index", "skipped", "No verified sources to index.");
        return { sources, contexts, trace };
      }

      report("Source index", "running", `${sources.length} verified sources`);
      const indexStarted = Date.now();
      try {
        await Promise.all(sources.map((source) => dependencies.index(source, request.verifiedQuote)));
        report("Source index", "done", `${sources.length} indexed`, Date.now() - indexStarted);
      } catch (error) {
        report("Source index", "failed", error instanceof Error ? error.message : "Indexing failed.", Date.now() - indexStarted);
      }
      return { sources, contexts, trace };
    },
  };
}
