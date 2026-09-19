import type { Env } from "./types";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function hasVerifiedQuote(value: unknown): value is { verifiedQuote: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).verifiedQuote === "string" &&
    (value as Record<string, unknown>).verifiedQuote.trim().length > 0
  );
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/trace") return json({ error: "Not found." }, 404);

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON." }, 400);
    }

    if (!hasVerifiedQuote(payload)) return json({ error: "verifiedQuote is required." }, 400);
    return json({ error: "Source tracing is not configured." }, 501);
  },
};
