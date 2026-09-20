export type SourceTraceState = "running" | "done" | "skipped" | "failed";

export interface SourceTraceEvent {
  type: "SOURCE_TRACE";
  step: string;
  state: SourceTraceState;
  detail?: string;
  ms?: number;
}

export interface VerifiedSource {
  title: string;
  url: string;
  excerpt: string;
  publisher: string;
  verifiedAt: string;
  sourceQuality: SourceQuality;
  verification: "verified";
}

export type SourceContextReason = "page_context" | "non_factual_context";
export type SourceQuality = "institutional_signal" | "credibility_unassessed";

export interface ContextSource {
  title: string;
  url: string;
  excerpt: string;
  publisher: string;
  verifiedAt: string;
  verification: "context";
  contextReasons: SourceContextReason[];
}

export interface SourceTraceResult {
  trace: SourceTraceEvent[];
  sources: VerifiedSource[];
  contexts: ContextSource[];
}

function contextSource(value: unknown): ContextSource | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const reasons = source.contextReasons;
  const validReasons = Array.isArray(reasons) && reasons.length > 0 && reasons.every(
    (reason): reason is SourceContextReason => reason === "page_context" || reason === "non_factual_context",
  );
  return (
    typeof source.title === "string" &&
    typeof source.url === "string" &&
    source.url.startsWith("https://") &&
    typeof source.excerpt === "string" &&
    typeof source.publisher === "string" &&
    typeof source.verifiedAt === "string" &&
    source.verification === "context" &&
    validReasons
  )
    ? {
        title: source.title,
        url: source.url,
        excerpt: source.excerpt,
        publisher: source.publisher,
        verifiedAt: source.verifiedAt,
        verification: source.verification,
        contextReasons: reasons,
      }
    : null;
}

function verifiedSource(value: unknown): VerifiedSource | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const sourceQuality = source.sourceQuality;
  const validQuality = sourceQuality === "institutional_signal" || sourceQuality === "credibility_unassessed";
  return (
    typeof source.title === "string" &&
    typeof source.url === "string" &&
    source.url.startsWith("https://") &&
    typeof source.excerpt === "string" &&
    typeof source.publisher === "string" &&
    typeof source.verifiedAt === "string" &&
    validQuality &&
    source.verification === "verified"
  )
    ? {
        title: source.title,
        url: source.url,
        excerpt: source.excerpt,
        publisher: source.publisher,
        verifiedAt: source.verifiedAt,
        sourceQuality,
        verification: source.verification,
      }
    : null;
}

function traceEvent(value: unknown): SourceTraceEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const event = value as Record<string, unknown>;
  return event.type === "SOURCE_TRACE" &&
    typeof event.step === "string" &&
    (event.state === "running" || event.state === "done" || event.state === "skipped" || event.state === "failed")
    ? {
        type: event.type,
        step: event.step,
        state: event.state,
        ...(typeof event.detail === "string" ? { detail: event.detail } : {}),
        ...(typeof event.ms === "number" ? { ms: event.ms } : {}),
      }
    : null;
}

/**
 * Folds one streamed record into `into`, returning its trace event if it carried one. A malformed
 * record is ignored: it cannot become evidence.
 */
function foldSourceTraceLine(line: string, into: SourceTraceResult): SourceTraceEvent | null {
  if (!line.trim()) return null;
  let message: { type?: unknown; sources?: unknown; contexts?: unknown } | null;
  try {
    message = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof message !== "object" || message === null) return null;

  const event = traceEvent(message);
  if (event) into.trace.push(event);
  if (message.type === "SOURCE_TRACE_DONE" && Array.isArray(message.sources)) {
    into.sources = message.sources.flatMap((source) => {
      const verified = verifiedSource(source);
      return verified ? [verified] : [];
    });
    into.contexts = Array.isArray(message.contexts)
      ? message.contexts.flatMap((source) => {
          const context = contextSource(source);
          return context ? [context] : [];
        })
      : [];
  }
  return event;
}

export function parseSourceTraceLines(lines: readonly string[]): SourceTraceResult {
  const result: SourceTraceResult = { trace: [], sources: [], contexts: [] };
  for (const line of lines) foldSourceTraceLine(line, result);
  return result;
}

/**
 * Streams one trace from the Worker, reporting each trace event as its line arrives. Aborting
 * `signal` cancels the request; the Worker stops the trace on its end when the body closes.
 */
export async function requestSourceTrace(
  endpoint: string,
  request: { claim: string; verifiedQuote: string; page: { url: string; title: string }; installId: string },
  onTrace: (event: SourceTraceEvent) => void,
  signal?: AbortSignal,
): Promise<SourceTraceResult> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw new Error(`Source tracing failed (${response.status}).`);
  if (!response.body) throw new Error("Source tracer returned no response stream.");

  const result: SourceTraceResult = { trace: [], sources: [], contexts: [] };
  const fold = (line: string) => {
    const event = foldSourceTraceLine(line, result);
    if (event) onTrace(event);
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remainder = "";
  while (true) {
    const { done, value } = await reader.read();
    remainder += decoder.decode(value, { stream: !done });
    const lines = remainder.split("\n");
    remainder = lines.pop() ?? "";
    lines.forEach(fold);
    if (done) break;
  }
  fold(remainder);
  return result;
}
