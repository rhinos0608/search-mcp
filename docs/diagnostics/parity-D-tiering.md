# Cluster D: Quality-Tier Heuristic — Diagnostic

## Current Mechanism

Source tiering is a **purely domain-level prior** system. It computes a numeric credibility score from the hostname alone, then buckets it into high/medium/low and attaches an explanation string. There is zero content-level signal in the tier computation.

### How the tier + explanation string is computed

**Score** — `src/utils/sourceTier.ts:211-239` (`getDomainAuthority(domain, category?)`):

1. Strip `www.` prefix, lowercase → bare domain
2. If `category === 'tweet'` and domain is `x.com`/`twitter.com` → return 0.95
3. Check `EXPLICIT_AUTHORITY` exact-match map (L21-49): known tech domains like `arxiv.org: 0.9`, `github.com: 0.8`, `stackoverflow.com: 0.8`, `developer.mozilla.org: 0.85`, etc.
4. Check `CURATED_HOSTS` suffix map (L64-69): e.g. `nature.com: 0.85`, `techcrunch.com: 0.6`
5. Check `OFFICIAL_FIRST_PARTY` exact map (L79-83): e.g. `nvidia.com: 0.75`, `openai.com: 0.75`
6. Check `GOV_SUFFIX_RE` regex (L157): `.gov`, `.mil`, and ccTLD variants → 0.85
7. Check `AUTHORITY_FAMILY_SUFFIXES` (L89-103): `ieee.org: 0.9`, `acm.org: 0.9`, `springer.com: 0.8`, etc.
8. Check `LOW_AUTHORITY_SUFFIXES` (L110-127): `youtube.com: 0.3`, `medium.com: 0.45`, `reddit.com: 0.4`, etc.
9. Check `isInstitutionalHost()` (ROR-registered education domains, L232-234) → 0.70
10. Check `SUFFIX_TIERS` regex list (L134-146): `.gov` 0.85, `.edu` 0.7, `.org` 0.45, `.com` 0.4, etc.
11. **Fallback** → `DEFAULT_AUTHORITY = 0.4` (L148)

**Label** — `src/utils/sourceTier.ts:245-250` (`getSourceQuality(domain, category?)`):
| Score range | Label |
|---|---|
| ≥ 0.75 | `high` |
| ≥ 0.50 | `medium` |
| < 0.50 | `low` |

**Basis/explanation** — `src/utils/sourceTier.ts:257-290` (`getSourceBasis(domain, category?)`):
| Match path | Basis string |
|---|---|
| `x.com`/`twitter.com` with `category === 'tweet'` | `"recognized social authority"` |
| `EXPLICIT_AUTHORITY` exact match | `"recognized technical authority"` |
| `CURATED_HOSTS` suffix match | host-specific (e.g. `"scientific publisher"`, `"established technology journalism"`, `"official company source"`) |
| `OFFICIAL_FIRST_PARTY` exact match | `"official company source"` |
| `GOV_SUFFIX_RE` | `"government domain"` |
| `AUTHORITY_FAMILY_SUFFIXES` | `"recognized technical family"` |
| `LOW_AUTHORITY_SUFFIXES` | host-specific (e.g. `"video platform"`, `"social platform"`, `"community platform"`, `"hosted publishing platform"`) |
| `isInstitutionalHost()` (ROR education) | `"academic domain"` (via `INSTITUTIONAL_BASIS`, `src/domainFacts/types.ts:102`) |
| `.edu` / `.ac.*` suffix | `"academic domain"` |
| **No match** | **`null`** |

### What "generic domain prior" is

`src/tools/webSearchResultFormatter.ts:900-907`:

```ts
const basis = result.sourceBasis
  ? ` — ${escapeMarkdownMetadataLabel(result.sourceBasis)}`
  : ' — generic domain prior';
parts.push(`quality: ${escapeMarkdownMetadataLabel(result.sourceQuality)}${basis}`);
```

`"generic domain prior"` is the **hardcoded fallback string** when `sourceBasis` is null. This happens when:

- Domain falls through to `SUFFIX_TIERS` (`.com` → 0.4, `.org` → 0.45, `.io` → 0.45, `.dev` → 0.45)
- Domain falls through to `DEFAULT_AUTHORITY = 0.4`
- Domain matches `LOW_AUTHORITY_SUFFIXES` but NOT the exact entries in `LOW_AUTHORITY_BASIS` (e.g. a `*.blogspot.com` subdomain that doesn't match the suffix check)

So: `low — generic domain prior` = domain is on a `.com`/`.org`/`.io`/`.dev` suffix, or is an unknown domain defaulting to 0.4 authority. `medium — generic domain prior` is not possible (0.4–0.5 = low), but `high — generic domain prior` CAN happen if a domain matches `SUFFIX_TIERS` for `.gov`/`.edu`/`.mil` but `getSourceBasis` returns null for those (actually it doesn't — `.gov` returns `"government domain"` and `.edu` returns `"academic domain"`). **Correction**: checking the code more carefully, `getSourceBasis` at L270-288 does handle `.gov`/`.edu`/`.ac.*` explicitly. So `high — generic domain prior` is effectively **impossible** — any domain scoring ≥0.75 will have a named basis. The `"generic domain prior"` fallback only appears for **low-tier** domains (score < 0.5) that fall to suffix/default.

### Enumerated tiers and triggers

| Tier                          | Score     | Label  | Example domains                                                            | Basis                            |
| ----------------------------- | --------- | ------ | -------------------------------------------------------------------------- | -------------------------------- |
| EXPLICIT_AUTHORITY            | 0.75–0.9  | high   | arxiv.org, github.com, stackoverflow.com, developer.mozilla.org            | "recognized technical authority" |
| CURATED_HOSTS                 | 0.55–0.85 | varies | nature.com (0.85), techcrunch.com (0.6), generalfusion.com (0.55)          | host-specific curated string     |
| OFFICIAL_FIRST_PARTY          | 0.75      | high   | nvidia.com, openai.com, developer.nvidia.com                               | "official company source"        |
| GOV_SUFFIX                    | 0.85      | high   | nasa.gov, gov.uk, defense.gov                                              | "government domain"              |
| AUTHORITY_FAMILY_SUFFIXES     | 0.8–0.9   | high   | ieee.org, acm.org, springer.com, nature.com                                | "recognized technical family"    |
| LOW_AUTHORITY_SUFFIXES        | 0.2–0.45  | low    | youtube.com (0.3), reddit.com (0.4), medium.com (0.45), blogspot.com (0.2) | platform-specific string         |
| INSTITUTIONAL (ROR education) | 0.70      | high   | registered education orgs (e.g. mit.edu via ROR)                           | "academic domain"                |
| SUFFIX_TIERS `.gov/.mil`      | 0.85      | high   | any `.gov`/`.mil`                                                          | "government domain"              |
| SUFFIX_TIERS `.edu`           | 0.70      | high   | any `.edu`                                                                 | "academic domain"                |
| SUFFIX_TIERS `.org/.io/.dev`  | 0.4–0.45  | low    | any `.org` (0.45), `.io` (0.45), `.dev` (0.45)                             | null → "generic domain prior"    |
| SUFFIX_TIERS `.com`           | 0.40      | low    | any `.com`                                                                 | null → "generic domain prior"    |
| DEFAULT                       | 0.40      | low    | anything not matched above                                                 | null → "generic domain prior"    |

## Is tiering used for ranking or only display?

**Both — but differently:**

1. **Ranking** uses the raw numeric `domainAuthority` score (from `getDomainAuthority`):
   - `src/utils/searchMerge.ts:179-184`: `domainAuthority * 0.3` in composite score
   - `src/utils/rescore.ts:162` → `src/config.ts:109`: `domainAuthority: 0.25` weight in `extractWebSearchSignals`
   - `src/tools/webSearch.ts:448`: `authorityFloor` tiebreaker in semantic rerank

2. **Display** uses `sourceQuality` and `sourceBasis`:
   - `src/tools/webSearchResultFormatter.ts:900-907`: renders `quality: high — recognized technical authority`
   - These are **never consulted by any ranking/scoring logic** — they're purely cosmetic

The `sourceQuality` and `sourceBasis` fields are set on `SearchResult` objects at:

- `src/utils/searchMerge.ts:191-193` (merge path)
- `src/tools/webSearch.ts:760-762` (RRF path)

## Content-level signals already computed elsewhere

### Available on `SearchResult` objects (set by providers/merge):

| Signal           | Field                                              | Source                                               | Already used in ranking?                       |
| ---------------- | -------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| Content kind     | `contentKind` (`'snippet' \| 'full' \| 'summary'`) | Provider-specific (Exa=full/summary, others=snippet) | No — only in dedup (`searchRichness.ts`)       |
| Content length   | `extraSnippet` + `description`                     | Provider-specific                                    | No — only in dedup tiebreak                    |
| Engine agreement | `engines: string[]`                                | `searchMerge.ts`                                     | Yes — `engineAgreement/2 * 0.4` in merge score |
| Publication date | `age` + `ageKind`                                  | Brave/Exa/SearXNG (Tavily/DDG/Codex=null)            | Yes — recency signal (0.12 weight)             |
| Deep links       | `deepLinks`                                        | Brave only                                           | Yes — hasDeepLinks signal (0.05 weight)        |
| AI summary       | `generatedSummary` + `generatedSummaryProvider`    | Exa/Tavily                                           | No — display only                              |
| Year alignment   | computed from `age`                                | `rescore.ts:166-172`                                 | Yes — yearAlignment signal (0.12 weight)       |

### Available elsewhere but NOT wired to web_search tiering:

| Signal                    | File                                     | What it computes                                                                                     | Why it could help                                                                                                                   |
| ------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Domain trust              | `src/utils/domainTrust.ts:203-290`       | trusted/standard/suspicious/blocked tier; lookalike detection; suspicious TLD detection; HTTPS check | Suspicious TLDs (`.xyz`, `.buzz`, `.tk`) and lookalike domains get `blocked`/`suspicious` — currently NOT used in web_search at all |
| Content length (richness) | `src/utils/searchRichness.ts:24-26`      | `description.length + extraSnippet.length`                                                           | Long, detailed snippets suggest substantive content                                                                                 |
| Content kind rank         | `src/utils/searchRichness.ts:17-21`      | `full=3, summary=2, snippet=1`                                                                       | Full-page text is a strong content quality signal                                                                                   |
| Boilerplate detection     | `src/rag/quality/boilerplateDetector.ts` | Detects template-heavy job listings                                                                  | Could detect low-quality scraped content in general search                                                                          |
| Page intent classifier    | `src/rag/quality/pageIntent.ts:107-169`  | JSON-LD detection, structural analysis                                                               | Could detect if a page is a real article vs. login/aggregator                                                                       |
| SERP guard                | `src/rag/quality/serpGuard.ts:158-226`   | Keyword relevance of results                                                                         | Could flag results that are irrelevant to query                                                                                     |

## Proposal: Adding content-level signals to tiering

### Signal 1: Content richness boost (LOW EFFORT, HIGH VALUE)

**Where available**: `contentKind` and `contentLength` are already on every `SearchResult` in the merge pipeline (`src/utils/searchMerge.ts:163`, `src/utils/searchRichness.ts:37-38`).

**How to combine**: After computing `domainAuthority`, apply a small content-richness bonus for results with `contentKind === 'full'` or `'summary'`. This rewards results where the backend was confident enough to fetch and return full content.

**Proposal**: In `getSourceBasis()`, add content-aware basis strings:

```
// When domain falls to "generic domain prior" BUT contentKind is 'full':
basis = "substantive content (full page text)"
// When domain falls to "generic domain prior" BUT generatedSummary is present:
basis = "has AI-generated summary"
```

**Implementation**: Modify `getSourceBasis` to accept an optional `SearchResult` parameter, or create a `getContentTier(result)` function that combines domain authority + content signals.

⚠️ **DESIGN CHOICE — NEEDS SIGN-OFF**: Should content signals upgrade the _label_ (display), the _score_ (ranking), or both? If both, the label accurately reflects what the user sees, but changes the ranking semantics.

### Signal 2: Domain trust integration (MEDIUM EFFORT, HIGH VALUE)

**Where available**: `src/utils/domainTrust.ts:203-290` — full trust system with `trusted/standard/suspicious/blocked` tiers, lookalike detection, suspicious TLD detection.

**Currently used**: Only in `semanticCrawl.ts` (opt-in via `DOMAIN_TRUST_ENABLED=true`). NOT used in web_search.

**How to combine**: Wire `evaluateDomainTrust()` into `getSourceBasis()` to catch suspicious TLDs and lookalike domains that currently fall through to "generic domain prior". A `.xyz` domain that `sourceTier.ts` doesn't match would get `DEFAULT_AUTHORITY = 0.4` and label `low — generic domain prior`, when it should get `low — suspicious TLD` or `low — possible lookalike`.

**Implementation**: In `getDomainAuthority()`, after the `SUFFIX_TIERS` check, call `evaluateDomainTrust()` for unmatched domains and use its `score` and `tier` to refine the authority score downward for suspicious domains.

⚠️ **DESIGN CHOICE — NEEDS SIGN-OFF**: `domainTrust` has its own scoring (0–1) that could conflict with `sourceTier` scoring. Which takes precedence? Should `domainTrust.blocked` override even explicit authorities?

### Signal 3: Snippet-length heuristic (LOW EFFORT, MEDIUM VALUE)

**Where available**: `description.length + extraSnippet.length` — already computed in `searchRichness.ts:24-26` (`contentLength()`).

**How to combine**: A very short description (< 100 chars) suggests the backend had little to extract — possibly a thin/aggregated page. A long description (> 500 chars) suggests substantive content.

**Proposal**: When `sourceBasis` is null ("generic domain prior"), add a content-length qualifier:

```
basis = "generic domain prior, thin content"     // description < 100 chars
basis = "generic domain prior, substantial content" // description > 500 chars
```

⚠️ **DESIGN CHOICE — NEEDS SIGN-OFF**: This changes the display label semantics — "thin content" is a content judgment, not a domain judgment. Is the label system the right place for content signals, or should content quality be a separate dimension?

### Signal 4: Engine agreement as confidence (LOW EFFORT, LOW VALUE)

**Where available**: `engines: string[]` on merged results (`src/utils/searchMerge.ts:194`).

**How to combine**: Multiple backends returning the same URL is a strong signal that the page is real and findable. Currently used in `searchMerge` scoring but not in tiering.

**Proposal**: When `sourceBasis` is null, append engine count:

```
basis = "generic domain prior, confirmed by N engines"
```

⚠️ **DESIGN CHOICE — NEEDS SIGN-OFF**: This adds informational value but could clutter labels. How many users read the basis string?

### Recommended implementation order

1. **Phase 1** (ranking-impacting — requires regression tests): Add `domainTrust` integration to `getDomainAuthority()` — catches suspicious/lookalike domains that currently masquerade as normal low-tier. This changes the numeric `domainAuthority` score used in ranking (`searchMerge.ts:179-184`, `rescore.ts:162`, `webSearch.ts:448`), not just the display label. **Precedence rule**: when `domainTrust` classifies a domain as `blocked` or `suspicious`, its score overrides any suffix-tier or default authority score, but never overrides `EXPLICIT_AUTHORITY` or `CURATED_HOSTS` exact matches — explicit human-curated authorities always take precedence. **Required before implementation**: ranking regression tests covering the merge composite score, rescore signal weights, and semantic-rerank authority floor to ensure no existing high-authority domains are downgraded.

2. **Phase 2** (display-only, low risk): Extend `getSourceBasis()` with content-aware qualifiers when the domain-based basis is null. Keeps domain tiering as the primary signal, adds content context as a secondary label.

3. **Phase 3** (ranking change, medium risk): Add content richness as a tiebreaking signal in `multiSignalRescore` — a new signal key `contentRichness` with weight ≤ rrfAnchor. Requires updating `RescoreConfig`, validation, and tests.

## Existing diagnostics overlap

This document complements `docs/diagnostics/web-search-ranking-quality.md` which covers the full scoring pipeline, signal gaps (H1–H6), and the `DOMAIN_AUTHORITY` map. That doc focuses on **ranking accuracy** (the numeric score path); this doc focuses on the **label accuracy** (the display path) and where content signals could bridge the gap.

---

## Summary

Source tiering is a domain-only prior system: `getDomainAuthority()` checks 11 lookup tables/regexes and returns a 0–1 score, which `getSourceQuality()` buckets into high/medium/low and `getSourceBasis()` labels with a named explanation. When no rule matches, the domain falls to suffix tiers or the default 0.4, and the formatter renders "generic domain prior" as the explanation. Content-level signals (contentKind, contentLength, domainTrust, engine agreement) exist in the codebase but are NOT wired into tiering — they're used for dedup, ranking, or are opt-in crawl-only. The tier labels are display-only; the underlying numeric score IS used for ranking. Adding content signals would require three design decisions: (1) should labels reflect content quality? (2) should content signals affect ranking or only display? (3) how to reconcile domainTrust scoring with sourceTier scoring?
