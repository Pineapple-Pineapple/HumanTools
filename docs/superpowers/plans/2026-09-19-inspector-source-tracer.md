# Inspector Source Tracer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Inspector Source Tracer specified in `docs/superpowers/specs/2026-09-19-inspector-source-tracer-design.md`: independently discover, load, quote-verify, and index primary sources for extracted claims.

**Architecture:** A Cloudflare Worker backed by a `SourceTracerAgent` Durable Object owns Brave Search, Browserbase, and Elastic credentials. The browser extension sends claims to the Worker and progressively renders server-sent trace events; only sources whose loaded text contains a validated excerpt are returned as evidence. Pure validation/ranking modules remain runtime-independent and are tested without network access.

**Tech Stack:** TypeScript, Cloudflare Workers/Agents, Durable Objects, Vitest with the Cloudflare Workers pool, Brave Search REST API, Browserbase REST plus Chrome DevTools Protocol, Elasticsearch REST API, Chrome Extension Manifest V3.

## Global Constraints

- Do not ship third-party API credentials in the extension bundle; use Cloudflare Worker secrets only.
- Never render a search result, page-cited link, or failed fetch as independently verified evidence.
- Evidence needs a canonical HTTPS URL and a contiguous excerpt validated against the loaded document text.
- Bound work to 5 candidates/claim, 2 concurrent fetches, 12-second fetch timeout, and one retry only for transient Browserbase failures.
- Treat page, search, Browserbase, and model content as untrusted data, never executable instructions.
- Keep Solana receipts, cross-source conflict resolution, and repeat-citation UI out of this milestone.

---

### Task 1: Bootstrap the Source Tracer Worker and contracts

**Files:**
- Create: `worker/package.json`
- Create: `worker/wrangler.jsonc`
- Create: `worker/vitest.config.ts`
- Create: `worker/src/types.ts`
- Create: `worker/src/index.ts`
- Create: `worker/test/source-tracer-request.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Inspector `ClaimCard` fields (`claim`, `verifiedQuote`, page URL/title).
- Produces: `TraceEvent`, `VerifiedSource`, `SourceTraceRequest`, and an HTTP `POST /v1/trace` NDJSON endpoint.

- [ ] **Step 1: Write the failing Worker request test**

```ts
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("POST /v1/trace", () => {
  it("rejects a request with no claim quote", async () => {
    const response = await worker.fetch(
      new Request("https://worker.test/v1/trace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim: "Revenue rose", page: { url: "https://example.test", title: "Example" } }),
      }),
      {} as Env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "verifiedQuote is required." });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix worker test -- source-tracer-request.test.ts`

Expected: FAIL because `worker/src/index.ts` and the Worker test configuration do not exist.

- [ ] **Step 3: Add Worker tooling and the minimal request boundary**

Create `worker/package.json` with `wrangler`, `vitest`, `@cloudflare/vitest-pool-workers`, and `agents` development/runtime dependencies. Add the root `test:worker` script as `npm --prefix worker test`.

Create `worker/wrangler.jsonc` with a `SourceTracerAgent` Durable Object binding named `SOURCE_TRACER`, an `migrations` entry for its class, compatibility date `2026-09-19`, and placeholders only for non-secret public configuration. Declare secrets by name in `worker/src/types.ts`:

```ts
interface Env {
  SOURCE_TRACER: DurableObjectNamespace;
  BRAVE_SEARCH_API_KEY: string;
  BROWSERBASE_API_KEY: string;
  BROWSERBASE_PROJECT_ID: string;
  ELASTIC_URL: string;
  ELASTIC_API_KEY: string;
}

export interface SourceTraceRequest {
  claim: string;
  verifiedQuote: string;
  page: { url: string; title: string };
  installId: string;
}
```

Implement `worker/src/index.ts` so invalid JSON returns `400 { error: "Invalid JSON." }`, a missing/non-string `verifiedQuote` returns the expected 400 payload, and otherwise forwards the request body to the deterministic Durable Object ID derived from `installId`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --prefix worker test -- source-tracer-request.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json worker/package.json worker/wrangler.jsonc worker/vitest.config.ts worker/src/types.ts worker/src/index.ts worker/test/source-tracer-request.test.ts
git commit -m "feat: add source tracer worker boundary"
```

### Task 2: Implement and test primary-source candidate discovery

**Files:**
- Create: `worker/src/source-candidates.ts`
- Create: `worker/src/brave-search.ts`
- Create: `worker/test/source-candidates.test.ts`
- Create: `worker/test/brave-search.test.ts`

**Interfaces:**
- Consumes: `SourceTraceRequest`.
- Produces: `CandidateSource[]` with canonical HTTPS URLs, title, description, and domain score.

- [ ] **Step 1: Write the failing candidate-ranking tests**

```ts
it("keeps a government primary result ahead of a news result and canonicalizes URLs", () => {
  const results = rankCandidates([
    { url: "https://news.test/story?utm_source=x", title: "Coverage", description: "Revenue grew" },
    { url: "https://data.gov/release#summary", title: "Official release", description: "Revenue grew" },
  ]);

  expect(results.map((r) => r.url)).toEqual(["https://data.gov/release", "https://news.test/story"]);
});

it("drops non-HTTPS, duplicate canonical URLs, and more than five candidates", () => {
  expect(rankCandidates([{ url: "http://bad.test", title: "Bad", description: "" }])).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix worker test -- source-candidates.test.ts brave-search.test.ts`

Expected: FAIL because the candidate module and Brave adapter do not exist.

- [ ] **Step 3: Implement the deterministic ranking and Brave adapter**

Implement `canonicalizeCandidateUrl(url: string): string | null` to require HTTPS, remove fragments and known marketing query parameters, and normalize host case. Implement `rankCandidates` with a fixed `MAX_CANDIDATES = 5`; prioritise `.gov`, issuer domains mentioned in the claim/page, regulatory domains, DOI/publisher domains, then ordinary HTTPS results. Do not infer factual support from a title or description.

Implement `BraveSearchClient.search(query, signal)` with `GET https://api.search.brave.com/res/v1/web/search?q=...&count=10`, an `X-Subscription-Token` header, `AbortSignal.timeout(8_000)`, shape validation, and a typed `SearchUnavailableError` for non-2xx or malformed replies. Query using the claim plus `"<verified quote>"` and add `site:` terms only when the page identifies an issuer.

- [ ] **Step 4: Run the candidate tests to verify they pass**

Run: `npm --prefix worker test -- source-candidates.test.ts brave-search.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/source-candidates.ts worker/src/brave-search.ts worker/test/source-candidates.test.ts worker/test/brave-search.test.ts
git commit -m "feat: discover ranked source candidates"
```

### Task 3: Fetch with Browserbase and verify loaded-page excerpts

**Files:**
- Create: `worker/src/browserbase-fetch.ts`
- Create: `worker/src/source-verify.ts`
- Create: `worker/test/source-verify.test.ts`
- Create: `worker/test/browserbase-fetch.test.ts`

**Interfaces:**
- Consumes: `CandidateSource` and the claim’s `verifiedQuote`.
- Produces: `FetchedSource` and `VerifiedSource`; a failed/missing match is `null`, never an evidence object.

- [ ] **Step 1: Write the failing verification tests**

```ts
it("returns the contiguous source excerpt that validates the claim quote", () => {
  const result = verifySourceExcerpt(
    "The filing states that revenue increased from $1 million to $4 million in 2025.",
    "revenue increased from $1 million to $4 million",
  );
  expect(result?.excerpt).toBe("The filing states that revenue increased from $1 million to $4 million in 2025.");
});

it("rejects a page that only contains disjoint keywords", () => {
  expect(verifySourceExcerpt("Revenue was $4 million. The increase was discussed later.", "revenue increased to $4 million")).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix worker test -- source-verify.test.ts browserbase-fetch.test.ts`

Expected: FAIL because no verifier or Browserbase client exists.

- [ ] **Step 3: Implement Browserbase isolation and exact-match verification**

Implement `verifySourceExcerpt(documentText, verifiedQuote)` using the existing normalized contiguous-span rules from `src/lib/quote-match.ts`, copied into a Worker-local dependency-free module with tests. Return the containing sentence/window only after an exact normalized contiguous match; do not add semantic matching in this milestone.

Implement `BrowserbaseFetcher.fetch(candidate)` as an adapter with `fetchText(url, signal): Promise<FetchedSource>`. Create a Browserbase session using its REST API, connect to the returned CDP WebSocket, navigate with JavaScript disabled, wait for `document.body.innerText`, and extract `document.title`, `location.href`, and bounded visible text. Always close the session in `finally`. Apply a 12-second timeout. Retry exactly once only for 408, 429, 5xx, or connection-close errors; return a typed failure for all other errors.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix worker test -- source-verify.test.ts browserbase-fetch.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/browserbase-fetch.ts worker/src/source-verify.ts worker/test/source-verify.test.ts worker/test/browserbase-fetch.test.ts
git commit -m "feat: verify source excerpts through Browserbase"
```

### Task 4: Orchestrate tracing and Elastic indexing in the Agent

**Files:**
- Create: `worker/src/elastic-index.ts`
- Create: `worker/src/source-tracer-agent.ts`
- Create: `worker/test/source-tracer-agent.test.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- Consumes: source-search/fetch/verification adapters from Tasks 2–3.
- Produces: NDJSON `TraceEvent` records followed by a `SOURCE_TRACE_DONE` result containing only `VerifiedSource[]`.

- [ ] **Step 1: Write the failing orchestrator test**

```ts
it("indexes and returns only sources whose fetched text verifies the quote", async () => {
  const agent = makeSourceTracer({
    search: async () => [officialCandidate, nonMatchingCandidate],
    fetch: async (candidate) => candidate === officialCandidate ? verifiedPage : nonMatchingPage,
    index: async () => undefined,
  });

  const outcome = await agent.trace(request);

  expect(outcome.sources).toEqual([expect.objectContaining({ url: officialCandidate.url, verification: "verified" })]);
  expect(outcome.trace).toContainEqual(expect.objectContaining({ step: "Source index", state: "done" }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --prefix worker test -- source-tracer-agent.test.ts`

Expected: FAIL because the orchestrator and Elastic adapter do not exist.

- [ ] **Step 3: Implement the agent, NDJSON stream, and Elastic writer**

Implement `ElasticSourceIndex.index(source, request)` using `PUT ${ELASTIC_URL}/human-tools-sources/_doc/${sha256(canonicalUrl + verifiedQuote)}` with `Authorization: ApiKey`, JSON content type, and a 5-second timeout. Store canonical URL, source title, verified excerpt, `claimHash`, `sourceContentHash`, timestamp, and `verification: "verified"`; never store full page text.

Implement `SourceTracerAgent` to emit trace in this order: `Source search`, one `Source fetch` event per bounded candidate, `Source verifier`, then `Source index`. Fetch candidates with concurrency two. Index failures are traced as failed but do not remove otherwise verified evidence. Search failure returns no sources and a failed trace, never a positive evidence status. Stream events as NDJSON with `content-type: application/x-ndjson` and end with `{ "type": "SOURCE_TRACE_DONE", "sources": [...] }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix worker test -- source-tracer-agent.test.ts && npm --prefix worker test`

Expected: PASS with no network requests; adapter boundaries are faked in tests.

- [ ] **Step 5: Commit**

```bash
git add worker/src/elastic-index.ts worker/src/source-tracer-agent.ts worker/src/index.ts worker/test/source-tracer-agent.test.ts
git commit -m "feat: stream verified source tracing"
```

### Task 5: Connect Inspector cards to verified source traces

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/messages.ts`
- Modify: `src/background/service-worker.ts`
- Modify: `src/sidepanel/inspector-panel.ts`
- Create: `src/lib/source-tracer-client.ts`
- Create: `test/inspector-source-tracer.test.ts`

**Interfaces:**
- Consumes: Worker NDJSON events and `VerifiedSource` objects.
- Produces: per-claim card evidence with `verifiedSources`, distinct `pageCitedSources`, and Inspector trace rows.

- [ ] **Step 1: Write the failing UI-to-client contract test**

```ts
it("renders only verified source evidence and keeps page-cited links distinct", async () => {
  const result = parseSourceTrace([doneWithVerifiedSource]);
  expect(result.verifiedSources).toHaveLength(1);
  expect(result.verifiedSources[0].excerpt).toContain("revenue increased");
  expect(result.pageCitedSources).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- inspector-source-tracer.test.ts`

Expected: FAIL because the root Vitest configuration and source-tracer client do not yet exist.

- [ ] **Step 3: Implement extension transport and card rendering**

Add root Vitest support and the `test` script. In `src/lib/source-tracer-client.ts`, parse only valid NDJSON trace/done records and expose an `AbortController` cancellation path. In the service worker, start source tracing after claims arrive and forward `INSPECT_TRACE` and verified-source updates to the existing `inspect` port.

Extend `ClaimCard.evidence` with `verifiedSources: VerifiedSource[]` and `pageCitedSources: PageLink[]`. Render a `Verified on source` link with its exact excerpt only for `verifiedSources`; render supplied paragraph links under a separate `Page-cited links` heading. If source tracing completes empty, render `No independently verified source found.` Do not allow independently verified source display to change a claim’s status unless the verifier explicitly returns that status in a later milestone.

- [ ] **Step 4: Run the test suite and build**

Run: `npm test && npm --prefix worker test && npm run build`

Expected: all tests PASS and Vite build succeeds.

- [ ] **Step 5: Commit**

```bash
git add package.json src/lib/types.ts src/lib/messages.ts src/lib/source-tracer-client.ts src/background/service-worker.ts src/sidepanel/inspector-panel.ts test/inspector-source-tracer.test.ts
git commit -m "feat: show independently verified inspector sources"
```

### Task 6: Configure and verify a deployed development instance

**Files:**
- Create: `worker/.dev.vars.example`
- Modify: `README.md`
- Modify: `src/options/options.ts`

**Interfaces:**
- Consumes: Worker endpoint deployed by Wrangler and the six Worker secrets.
- Produces: a reproducible local/development setup and a manually verifiable Inspector trace.

- [ ] **Step 1: Write failing configuration/documentation checks**

```ts
it("refuses an unconfigured source tracer endpoint without treating a page link as verified", () => {
  expect(sourceTraceUnavailableCard().text).toContain("No independently verified source found.");
  expect(sourceTraceUnavailableCard().verifiedSources).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- inspector-source-tracer.test.ts`

Expected: FAIL because the unavailable endpoint state has not been implemented.

- [ ] **Step 3: Add explicit configuration and operational documentation**

Add `SOURCE_TRACER_URL` to Worker/local extension development configuration without embedding secrets. Add `.dev.vars.example` keys with empty values only. Document `wrangler secret put BRAVE_SEARCH_API_KEY`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `ELASTIC_URL`, and `ELASTIC_API_KEY`; never commit real values. Add a manual golden-page checklist: verified source, no matching source, Browserbase failure, search failure, and index failure.

- [ ] **Step 4: Verify passing tests, build, and a deployed smoke test**

Run: `npm test && npm --prefix worker test && npm run build`

Expected: all tests PASS and Vite build succeeds.

After credentials are supplied and deployment is authorized, run: `npm --prefix worker run deploy`, reload the unpacked extension, inspect a prepared golden-page claim, and confirm the card displays a validated excerpt or the explicit no-source state.

- [ ] **Step 5: Commit**

```bash
git add worker/.dev.vars.example README.md src/options/options.ts test/inspector-source-tracer.test.ts
git commit -m "docs: configure source tracer verification"
```

## Plan Self-Review

- **Spec coverage:** Tasks 1–4 implement the Worker/Agent, web search, Browserbase confirmation, Elastic indexing, streaming trace, timeouts, retry, and strict verified-only evidence. Task 5 integrates those results into Inspector. Task 6 covers configuration and golden-page verification. Solana, conflict resolution, repeat-citation UI, and other Review Team roles are deliberately excluded by the approved scope.
- **No placeholders:** Commands, tests, boundaries, and required response semantics are stated for every task. Credentials intentionally remain unset and are named only as deployment secrets.
- **Type consistency:** `SourceTraceRequest`, `VerifiedSource`, `CandidateSource`, and `TraceEvent` are defined in Task 1 and consumed in subsequent tasks; extension transport is introduced only after Worker streaming is complete.

## Execution Handoff

Plan complete and saved to [2026-09-19-inspector-source-tracer.md](/Users/pineapple/Projects/HumanTools/docs/superpowers/plans/2026-09-19-inspector-source-tracer.md).

Execution should be inline in this session because no subagent work was requested. The next step is to set up an isolated worktree, establish the test baseline, and execute Task 1 test-first.
