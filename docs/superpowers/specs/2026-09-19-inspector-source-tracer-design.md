# Inspector Source Tracer Design

## Goal

Extend Inspector so it independently finds and verifies primary sources for each extracted claim. The card displays only sources that were fetched and whose extracted text supports the claim. Solana receipts are explicitly out of scope.

## Scope

This milestone implements the spec's Source Tracer path: server-side web search, Browserbase source loading, span verification, Elastic indexing, and progressively streamed Inspector trace updates. It does not implement the other Review Team roles, cross-source conflict resolution, Solana receipts, or stealth-edit detection.

## Architecture

The extension continues to capture a selection and extract typed claims. For each claim, it calls a Cloudflare Worker endpoint that owns all third-party credentials. The Worker runs the Source Tracer and returns only verified source evidence plus trace events; no search, Browserbase, or Elastic credential is shipped to the extension.

The Worker receives the normalized claim, its verified page quote, page context, and page-cited links. It first queries a server-side web search provider for a bounded set of likely primary sources. It ranks official issuers, government bodies, research publishers, and regulatory filings ahead of commentary and secondary coverage. It deduplicates candidates by canonical URL.

The Worker uses Browserbase to load each candidate within a fixed concurrency and timeout budget. It extracts the reader-visible document text and metadata, then validates a contiguous matching excerpt against the claim quote. A source is evidence only if that verification succeeds. Search candidates that cannot load, do not contain a supporting excerpt, or fail validation are discarded rather than sent to the card.

Verified claim/source pairs are indexed in Elastic with a content hash, canonical URL, source title, excerpt, and verification timestamp. The first UI milestone records the data and trace count; repeat-citation presentation is deferred until the later provenance feature.

## Data Contract

The Worker streams trace events for `Source search`, `Source fetch`, `Source verifier`, and `Source index`. Each event has a running, done, skipped, or failed state and may include a safe operational detail and duration.

The final result contains `VerifiedSource[]`, where each item has a title, canonical URL, exact supporting excerpt, publisher/domain, and verification timestamp. The extension renders these as `Verified on source` links. It retains page-provided links separately as `Page-cited` context and never treats them as independently verified evidence.

When no source passes validation, the card says `No independently verified source found.` An operational failure (search unavailable, Browserbase outage, or index failure) is visible in Trace and does not upgrade any evidence status.

## Reliability and Safety

The Worker limits search results and source fetches per claim, deduplicates URLs, enforces per-service timeouts, and retries a transient Browserbase fetch once. It validates every returned source URL and excerpt before returning it. All model/search/page content is untrusted data; it is not interpreted as Worker instructions.

Credentials are held in Cloudflare secrets: search-provider key, Browserbase key/project, Elastic endpoint/API key, and any model key used server-side. The extension uses an anonymous installation identifier and the Worker rate-limits that identifier to prevent public endpoint abuse.

## Testing

Unit tests cover source candidate ranking/deduplication, quote/excerpt validation, rejection of malformed or non-HTTP results, and Worker response parsing. Worker integration tests mock the search, Browserbase, and Elastic boundaries and verify that only verified sources are returned or indexed. A golden-page end-to-end test proves the extension renders a verified excerpt, a no-source state, and a source-fetch failure in Trace.

## Acceptance Criteria

- A card displays only fetched sources with a validated supporting excerpt.
- Unavailable or unmatched candidates do not appear as evidence.
- The UI distinguishes `Verified on source` from `Page-cited` links.
- Trace reflects source search, fetching, verification, indexing, and failures.
- Browserbase, search, and Elastic secrets remain outside the extension bundle.
- A search or Browserbase failure leaves the card cautious and usable.
