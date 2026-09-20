import { readTraceRequest } from "./trace-request";
import type { Env } from "./types";
export { SourceTracerAgent } from "./source-tracer-do";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/trace") return json({ error: "Not found." }, 404);

    const parsed = await readTraceRequest(request);
    if (!parsed.ok) return json({ error: parsed.error }, 400);

    // The agent sees only the validated fields, never the caller's raw body or headers.
    const id = env.SOURCE_TRACER.idFromName(parsed.request.installId);
    return env.SOURCE_TRACER.get(id).fetch(
      new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.request),
      }),
    );
  },
};
