# Inspector Source Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate page context and known non-factual publisher matches from genuinely eligible external source verification in the Inspector.

**Architecture:** The Worker classifies loaded, exact-quote matches only after resolving the final URL. It returns eligible external sources separately from context records and only indexes eligible sources. The extension carries both collections over its existing trace boundary; the Inspector renders them in separate sections with unambiguous copy.

**Tech Stack:** TypeScript, Cloudflare Workers Durable Objects, Vitest, Chrome Extension MV3.

## Global Constraints

- A canonical URL equal to the inspected page is never external verification, including after a redirect.
- `theonion.com` is the initial known non-factual publisher; its role is annotation, never the sole trust rule.
- Eligible external sources disclose either an institutional/public-record signal or credibility unassessed; neither label is a general trust verdict.
- Context reasons are additive: a same-page Onion article explains both circularity and non-factual status.
- Only `external_verified` sources are indexed in `human-tools-sources`.
- No credential values, full fetched page content, or new external services are introduced.

---

### Task 1: Classify loaded source matches in the Worker

**Files:**
- Modify: `worker/src/source-candidates.ts`
- Modify: `worker/src/source-tracer-agent.ts`
- Modify: `worker/test/source-candidates.test.ts`
- Modify: `worker/test/source-tracer-agent.test.ts`

**Interfaces:**
- Produces `SourceContextReason = "page_context" | "non_factual_context"`, `SourceQuality = "institutional_signal" | "credibility_unassessed"`, and `classifySourceContext(fetchedUrl, inspectedUrl): SourceContextReason[]`.
- Extends `SourceTraceOutcome` with `contexts: ContextSource[]`; `sources` remains eligible external sources only.

- [ ] **Step 1: Write the failing classification tests**

```ts
it("marks a canonical same-page URL as page context", async () => {
  const module = await loadCandidates();
  expect(module?.classifySourceContext(
    "https://example.test/article?utm_source=search",
    "https://example.test/article#claim",
  )).toEqual(["page_context"]);
});

it("adds the non-factual warning for The Onion", async () => {
  const module = await loadCandidates();
  expect(module?.classifySourceContext(
    "https://theonion.com/story",
    "https://reader.test/article",
  )).toEqual(["non_factual_context"]);
});

it("marks an ordinary external domain as credibility unassessed", async () => {
  const module = await loadCandidates();
  expect(module?.sourceQuality("https://example.net/report")).toBe("credibility_unassessed");
});
```

Add an orchestrator test whose only matching fetched page has URL `https://page.test/article` while the request page is `https://page.test/article#selected`. Assert `outcome.sources` and `indexed` are empty, `outcome.contexts` contains `page_context`, and the verifier trace is skipped with `"Page context only."`.

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run test/source-candidates.test.ts test/source-tracer-agent.test.ts`

Expected: FAIL because `classifySourceContext` and `outcome.contexts` do not exist.

- [ ] **Step 3: Implement canonical classification and eligibility**

In `worker/src/source-candidates.ts`, export the following helper beside `canonicalizeCandidateUrl`:

```ts
export type SourceContextReason = "page_context" | "non_factual_context";

const NON_FACTUAL_DOMAINS = new Set(["theonion.com"]);

export function classifySourceContext(fetchedUrl: string, inspectedUrl: string): SourceContextReason[] {
  const reasons: SourceContextReason[] = [];
  const fetched = canonicalizeCandidateUrl(fetchedUrl);
  const inspected = canonicalizeCandidateUrl(inspectedUrl);
  if (fetched !== null && fetched === inspected) reasons.push("page_context");
  if (fetched !== null && NON_FACTUAL_DOMAINS.has(new URL(fetched).hostname.replace(/^www\./, ""))) {
    reasons.push("non_factual_context");
  }
  return reasons;
}
```

Export `sourceQuality(url)` from `worker/src/source-candidates.ts`. It returns `institutional_signal` when the existing primary-source score is positive and `credibility_unassessed` otherwise. In `worker/src/source-tracer-agent.ts`, define `ContextSource` with the existing source metadata, excerpt, `contextReasons`, and `verification: "context"`. After `verifySourceExcerpt` succeeds, call `classifySourceContext(fetched.url, request.page.url)`. Push nonempty-reason results into `contexts`, emit a skipped verifier event with `"Page context only."`, `"Known non-factual publisher."`, or both joined by a space, and return `null` from the eligible-source branch. Add `sourceQuality` to eligible sources only; only sources with no context reasons continue to the index call.

- [ ] **Step 4: Run the Worker tests**

Run: `npx vitest run test/source-candidates.test.ts test/source-tracer-agent.test.ts && npx tsc -p tsconfig.json`

Expected: PASS; same-page, redirect-resolved, and Onion matches are context-only while a distinct government source is still indexed.

- [ ] **Step 5: Commit**

```bash
git add worker/src/source-candidates.ts worker/src/source-tracer-agent.ts worker/test/source-candidates.test.ts worker/test/source-tracer-agent.test.ts
git commit -m "feat: classify source context separately"
```

### Task 2: Carry context records through the Worker response and extension client

**Files:**
- Modify: `worker/src/source-tracer-do.ts`
- Modify: `src/lib/source-tracer-client.ts`
- Modify: `src/lib/messages.ts`
- Modify: `src/background/service-worker.ts`
- Modify: `test/source-tracer-client.test.ts`

**Interfaces:**
- `SOURCE_TRACE_DONE` carries `{ sources: VerifiedSource[]; contexts: ContextSource[] }`; each verified source has `sourceQuality`.
- `SourceTraceResult` exposes both arrays.
- `INSPECT_SOURCES` carries `sourcesByQuote` and `contextsByQuote` keyed by verified quote.

- [ ] **Step 1: Write the failing client parsing test**

```ts
it("keeps valid context separately from verified external sources", async () => {
  const module = await loadClient();
  const result = module?.parseSourceTraceLines([
    JSON.stringify({
      type: "SOURCE_TRACE_DONE",
      sources: [],
      contexts: [{
        title: "Satire article",
        url: "https://theonion.com/story",
        excerpt: "Claim text.",
        publisher: "theonion.com",
        verifiedAt: "2026-09-19T12:00:00.000Z",
        verification: "context",
        contextReasons: ["page_context", "non_factual_context"],
      }],
    }),
  ]);

  expect(result?.sources).toEqual([]);
  expect(result?.contexts).toEqual([expect.objectContaining({ verification: "context" })]);
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- source-tracer-client.test.ts`

Expected: FAIL because `SourceTraceResult` does not expose `contexts`.

- [ ] **Step 3: Implement strict parsing and message propagation**

Add exported client-side `SourceContextReason = "page_context" | "non_factual_context"`, `SourceQuality = "institutional_signal" | "credibility_unassessed"`, and `ContextSource` types. Require a verified source's valid `sourceQuality`; require HTTPS URL, title, excerpt, publisher, ISO-like timestamp string, `verification: "context"`, and a nonempty subset of context reasons for context parsing.

Change `requestSourceTrace` to return `Promise<SourceTraceResult>` rather than only `VerifiedSource[]`. In `worker/src/source-tracer-do.ts`, append `contexts: outcome.contexts` to `SOURCE_TRACE_DONE`. Update `InspectSources`, `runSourceTracer`, and the cache so each claim stores both `{ sources, contexts }`; an invalid or missing Worker record becomes no evidence, never a positive label.

- [ ] **Step 4: Run client and extension type checks**

Run: `npm test -- source-tracer-client.test.ts && npx tsc -p tsconfig.json && npx tsc -p worker/tsconfig.json`

Expected: PASS with malformed context records ignored.

- [ ] **Step 5: Commit**

```bash
git add worker/src/source-tracer-do.ts src/lib/source-tracer-client.ts src/lib/messages.ts src/background/service-worker.ts test/source-tracer-client.test.ts
git commit -m "feat: stream source context separately"
```

### Task 3: Render context and external evidence as distinct Inspector sections

**Files:**
- Modify: `src/sidepanel/inspector-panel.ts`
- Modify: `README.md`

**Interfaces:**
- `renderVerifiedSources(quote, sources, contexts)` is called for each `INSPECT_SOURCES` record.
- The Inspector never describes page context or a non-factual publisher as verification.

- [ ] **Step 1: Add a focused rendering seam and failing assertions**

Export a pure helper from `src/sidepanel/inspector-panel.ts`:

```ts
export function sourceContextMessage(reasons: readonly SourceContextReason[]): string {
  if (reasons.includes("page_context") && reasons.includes("non_factual_context")) {
    return "This is the inspected page and a known satire/non-factual publisher — not evidence for this claim.";
  }
  if (reasons.includes("page_context")) return "This exact text appears on the inspected page — not external verification.";
  return "Known satire/non-factual publisher — not evidence for this claim.";
}
```

Create `test/inspector-source-context.test.ts` asserting each of the three messages. This keeps copy correctness testable without a DOM fixture.

- [ ] **Step 2: Run the failing rendering test**

Run: `npm test -- inspector-source-context.test.ts`

Expected: FAIL because `sourceContextMessage` is not exported.

- [ ] **Step 3: Implement the presentation split**

Replace every user-facing “Independent verification” label with **“External verification”**. Initially render “Checking external sources…”. Render a **“Page context — not verification”** sub-section only if context records exist; include each source link, the exact excerpt, and `sourceContextMessage(context.contextReasons)`. The external section renders only `VerifiedSource[]`, labels each row “Exact quote verified on external source”, and adds “Institutional/public-record signal” for `institutional_signal` or “Credibility not established” for `credibility_unassessed`. It falls back to “No external verification found.”

Update the footer to say: “A matching source is evidence only when it is a distinct eligible external page. Text found on this page is context, not verification. No result is not proof that a claim is false.” Update the README with the same distinction and note that The Onion is initially annotated as known non-factual context.

- [ ] **Step 4: Run full verification and build**

Run: `npm test && npx tsc -p tsconfig.json && npm run build && (cd worker && npm test && npx tsc -p tsconfig.json)`

Expected: all tests pass; the production extension bundle and Worker type-check complete.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel/inspector-panel.ts test/inspector-source-context.test.ts README.md
git commit -m "feat: distinguish source context from verification"
```

### Task 4: Deploy and verify the live contract

**Files:**
- No source changes.

**Interfaces:**
- The deployed Worker returns contexts separately and accepts only eligible sources for Elasticsearch indexing.

- [ ] **Step 1: Deploy the Worker from its service directory**

Run: `npx wrangler deploy`

Working directory: `/Users/pineapple/Projects/HumanTools/worker`

Expected: deployment identifies `human-tools-source-tracer` and prints a version ID.

- [ ] **Step 2: Exercise an explicit same-page/satire trace**

Run a `POST /v1/trace` for the Onion passage. Confirm the NDJSON completion record has a nonempty `contexts` array with both reasons, an empty `sources` array, and a skipped Source index event.

- [ ] **Step 3: Reload the unpacked extension and inspect the Onion passage**

Expected: the card shows **Page context — not verification**, the satire warning, and **No external verification found**. It must not show a green verified label or an Elasticsearch indexing success for the Onion page.

- [ ] **Step 4: Commit deployment-only documentation if changed**

Do not commit generated bundles, credentials, `.env`, or unrelated user changes.
