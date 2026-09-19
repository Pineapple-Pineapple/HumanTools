import type { Env } from "./types";
export { SourceTracerAgent } from "./source-tracer-do";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function hasVerifiedQuote(value: unknown): value is { verifiedQuote: string; installId?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).verifiedQuote === "string" &&
    (value as Record<string, unknown>).verifiedQuote.trim().length > 0
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/trace") return json({ error: "Not found." }, 404);

    let payload: unknown;
    try {
      payload = await request.clone().json();
    } catch {
      return json({ error: "Invalid JSON." }, 400);
    }

    if (!hasVerifiedQuote(payload)) return json({ error: "verifiedQuote is required." }, 400);
    if (typeof payload.installId !== "string" || !payload.installId.trim()) return json({ error: "installId is required." }, 400);
    const id = env.SOURCE_TRACER.idFromName(payload.installId);
    return env.SOURCE_TRACER.get(id).fetch(request);
  },
};
