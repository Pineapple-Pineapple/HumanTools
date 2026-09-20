import type { SourceTraceRequest } from "./types";

/**
 * Caps on what a caller may send. The claim and quote become a paid search query and a browser
 * fetch budget, so an oversized body is refused before any of that is spent.
 */
export const LIMITS = {
  /** Characters of raw body, which is a lower bound on bytes; the content-length header is checked first. */
  body: 16 * 1024,
  claim: 500,
  verifiedQuote: 1000,
  installId: 128,
  pageUrl: 2048,
  pageTitle: 500,
} as const;

export type ParsedTraceRequest = { ok: true; request: SourceTraceRequest } | { ok: false; error: string };

class InvalidTraceRequest extends Error {}

function text(value: unknown, name: string, max: number, required = true): string {
  if (typeof value !== "string" || (required && !value.trim())) throw new InvalidTraceRequest(`${name} is required.`);
  if (value.length > max) throw new InvalidTraceRequest(`${name} exceeds ${max} characters.`);
  return value;
}

export function parseTraceRequest(value: unknown): ParsedTraceRequest {
  try {
    if (typeof value !== "object" || value === null) throw new InvalidTraceRequest("Request body must be a JSON object.");
    const body = value as Record<string, unknown>;
    const page = (typeof body.page === "object" && body.page !== null ? body.page : {}) as Record<string, unknown>;
    return {
      ok: true,
      request: {
        verifiedQuote: text(body.verifiedQuote, "verifiedQuote", LIMITS.verifiedQuote),
        installId: text(body.installId, "installId", LIMITS.installId),
        claim: text(body.claim, "claim", LIMITS.claim, false),
        page: {
          url: text(page.url, "page.url", LIMITS.pageUrl),
          title: text(page.title, "page.title", LIMITS.pageTitle, false),
        },
      },
    };
  } catch (error) {
    if (error instanceof InvalidTraceRequest) return { ok: false, error: error.message };
    throw error;
  }
}

export async function readTraceRequest(request: Request): Promise<ParsedTraceRequest> {
  if (Number(request.headers.get("content-length")) > LIMITS.body) return { ok: false, error: "Request body is too large." };
  let body: string;
  try {
    body = await request.text();
  } catch {
    return { ok: false, error: "Invalid JSON." };
  }
  if (body.length > LIMITS.body) return { ok: false, error: "Request body is too large." };
  try {
    return parseTraceRequest(JSON.parse(body));
  } catch {
    return { ok: false, error: "Invalid JSON." };
  }
}
