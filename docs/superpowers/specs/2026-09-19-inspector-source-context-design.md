# Inspector Source Context Design

## Goal

Make it unmistakable whether a claim's matching text comes from the inspected page, an eligible external source, or a known non-factual publisher. A page must never validate itself.

## Source Classification

The Source Tracer classifies a fetched exact-quote match after Browserbase resolves its final URL.

| Classification | Rule | Evidence meaning |
| --- | --- | --- |
| `external_verified` | Its canonical resolved URL differs from the inspected page and its domain is not on the non-factual list. | Eligible external evidence. |
| `page_context` | Its canonical resolved URL is the inspected page. | Adds a context reason: the page only confirms that it contains its own text. |
| `non_factual_context` | Its domain is in the known non-factual publisher list. | Adds a context reason: the publisher is non-factual. |

Canonical comparison removes fragments and tracking parameters before comparing URLs. The comparison happens after fetch so redirects back to the inspected page cannot evade it.

Context reasons are additive. A same-page result from a known non-factual publisher carries both reasons, so the Inspector can explain the circularity and the publisher warning together.

## Eligibility and Storage

Only `external_verified` sources are returned through the existing verified-source channel and indexed in `human-tools-sources`. Page and non-factual context are returned separately and are never indexed as verified evidence.

The first non-factual publisher is `theonion.com`. The list is an explicit annotation layer, not the system's primary trust rule: URL distinction is always required for external verification.

## Source-quality disclosure

Every eligible external source has a separate quality disclosure. `institutional_signal` applies to the existing government, regulator, DOI, academic, and named scientific-publication domain signals. All other external sources are `credibility_unassessed`: the exact quote was found on a distinct page, but the product has not established that publisher's reliability. Known non-factual sources are context-only and receive their existing warning.

The UI must never call a source generally “trustworthy.” A quote match proves only that a distinct page contains the text; source-quality labels tell the reader whether the product has a limited institutional signal or no reliability assessment.

## Inspector Presentation

Each claim has two sections:

1. **Page context — not verification** shows a same-page exact match and explains that it cannot support the page's own claim.
2. **External verification** shows only eligible external sources, each marked “Exact quote verified on external source.”

Each external row also says either “Institutional/public-record signal” or “Credibility not established.”

Known non-factual matches appear in the page-context section with “Known satire/non-factual publisher — not evidence for this claim.” When no eligible external source exists, the external section says “No external verification found.” The claim remains Unverified; absence of evidence is not evidence of falsity.

## Trace and Errors

The trace emits a skipped verifier event when a source is retained as page or non-factual context, with a reason that maps to the Inspector copy. Search, browser loading, quote matching, and Elastic indexing behavior otherwise stay unchanged.

## Tests

- A fetched same-page URL is returned as `page_context`, not indexed, and never appears among verified sources.
- A redirect resolving to the inspected canonical URL gets the same treatment.
- A `theonion.com` match is returned as `non_factual_context`, not indexed, and never appears among verified sources.
- A distinct eligible source remains verified and indexed.
- Client parsing preserves context items separately from verified sources.
