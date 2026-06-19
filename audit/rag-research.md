# RAG / Research / Data Pipeline Audit

Repo: `/Users/rhinesharar/search-mcp`
Scope: `semantic_crawl`, research orchestrator/job protocol, corpus cache, retrieval fusion, source quality/provenance, response compaction, current diff interactions.
Method: read-only inspection. No files modified. Findings cite file:line.

Legend: `[B]` blocker · `[F]` fix · `[N]` note.

---

## Review

### Correct (with evidence)

- RRF fusion (`src/utils/fusion.ts`) is correct: intra-ranking dedup via `keyFn`, cross-ranking sum via `getId`/`keyFn`, last-ranking metadata wins across rankings only. No race in score accumulator.
- BM25+ (`src/utils/bm25.ts`) — correct smoothed IDF, dedup of query terms, returns scores sorted desc.
- `chunkMarkdown` (`src/chunking.ts`) — atomic-unit aware split, overlap snap to sentence boundary, re-index after post-process at line 311-312 keeps `chunkIndex`/`totalChunks` consistent.
- Corpus cache schema (`src/utils/corpusCache.ts:319-403`) — `cache_meta.schemaVersion`, indexes, cascade delete, content hash validation at line 570-577 reject tampered rows.
- `semanticCrawl` `crawlSeeds` preflight size guard (`src/tools/semanticCrawl.ts:930-964`) — caps `maxPages` against `SAFE_BYTES` before dispatch; correct behavior for JS-heavy vs default sites.
- Job manager lifecycle (`src/research/jobManager.ts`) — status guards prevent cancel-after-terminal; `runCleanup` (`src/research/jobManager.ts:584-626`) offloads saved results, expires unsaved after 24h, defensive force-expire for stuck running/cancelling jobs.
- `deepResearch` path-traversal protection (`src/tools/standalone/deepResearch.ts:446-478`) — absolute paths rejected, boundary check via `resolved.startsWith(safeBaseDir + path.sep)` correctly prevents `research-results-evil/` escape.
- `softLexicalConstraint` (`src/utils/lexicalConstraint.ts`) — IDF over query tokens, top-3 weighted, ≥2 matches required; graceful fallback when zero matches.
- Recent diff: `scripts/run-tests.cjs:97-107` — added test-dir existence check after compile. Catches silent TSC failure that previously produced exit 0 with no tests run.

---

### Fixed

- (none — review-only, no edits applied)

---

### Blocker

- **No plan.md / progress.md found.** Repository root does not contain `plan.md` or `progress.md` referenced in the task brief. Audit ran against HEAD + AGENTS.md scope + working-tree diff (`git status --short` shows 9 modified files). All findings below are derived from this view.

---

### Issues

#### `[F1]` `agenticBrowse.stripHtml` entity decoding is a no-op

`src/tools/families/agenticBrowse.ts:88-110`

Lines 100-103 replace `<`, `>`, `"`, `&#39;` with the _same characters_. These are no-op substitutions:

```ts
.replace(/</g, '<')   // line 100
.replace(/>/g, '>')   // line 101
.replace(/"/g, '"')   // line 102
.replace(/&#39;/g, "'") // line 103
```

Effect: HTML entities in titles/content (e.g. `&lt;`, `&gt;`, `&quot;`, `&apos;`) reach the LLM undecoded. `read`, `present`, `browse_and_present` actions all funnel through `stripHtml`.

**Smallest safe fix:** replace those four lines with literal entity decoders, e.g.:

```ts
.replace(/&lt;/g, '<')
.replace(/&gt;/g, '>')
.replace(/&quot;/g, '"')
.replace(/&#39;|&apos;/g, "'")
```

`&amp;` decoding already correctly runs last at line 105.

**Targeted test:** add `test/agenticBrowse/stripHtml.test.ts` with inputs covering `&lt;script&gt;` (expect decoded brackets), `Tom &amp; Jerry` (expect `&`), and double-encoded `&amp;lt;` (expect `<`).

---

#### `[F2]` `agenticBrowse.read` is a dead duplicate of `browse_and_present`

`src/tools/families/agenticBrowse.ts:145-156` (schema) and `:252-279` (handler) vs `:132-143` and `:225-251`.

The `read` action body and return shape are byte-identical to `browse_and_present`. The only difference is the description string. Both store the page in `documentStore` (lines 240 and 268), so `read` is _not_ one-shot despite the description saying so.

**Smallest safe fix:** delete the `read` action (`name: 'read'`, schema, handler, and the doc comment at line 11). Keep `browse_and_present` as the single combined call. If a true read-only action is wanted, remove the `documentStore.set` at line 268 and the `documentId` from the response.

**Targeted test:** if kept as-is, add `test/agenticBrowse/read.test.ts` asserting the schema description matches actual behavior (no `documentStore` write), or remove the action and delete `test/familyConsolidation.test.ts` cases that reference `read`.

---

#### `[F3]` `corpusCache.invalidateCorpus` does not match `pendingBuilds` key when variant is set

`src/utils/corpusCache.ts:998-1010` vs `:772-775`.

`getOrBuildCorpus` writes `pendingBuilds[stableStringify(normalizeSource(source)) + variantSuffix]`, where `variantSuffix = variant ? `|${variant}` : ''`.

`invalidateCorpus` deletes `pendingBuilds[stableStringify(normalizeSource(source))]` — without the variant suffix. If `variant` was non-empty (e.g. contextual embeddings), the cancellation key misses, and an in-flight variant build proceeds to write the row that the caller tried to invalidate.

**Smallest safe fix:** in `invalidateCorpus` line 1008, pass variant into the key computation, or call:

```ts
pendingBuilds.delete(stableStringify(normalizeSource(opts.source)));
for (const key of pendingBuilds.keys()) {
  if (key.startsWith(stableStringify(normalizeSource(opts.source)) + '|')) {
    pendingBuilds.delete(key);
  }
}
```

**Targeted test:** `test/corpusCache/invalidate.test.ts` — set `variant: 'ctx'`, start a slow materialize, call `invalidateCorpus(id, { source, variant: 'ctx' })`, assert `pendingBuilds` no longer holds the promise.

---

#### `[F4]` `researchJobManager` runtime timeout never cleared on terminal transitions

`src/research/jobManager.ts:578-582` (`disarmJob`) and call sites at lines 281, 301, 352.

`disarmJob` clears `abortController` but does not call `clearTimeout(job.runtimeTimeout)`. The `setTimeout` at line 561-566 fires up to `maxTimeMs` (5–45 minutes) later, holds a closure over `job`, prevents GC, and performs a no-op when fired (guard `if (job.abortController && ...)` catches the cleared undefined but the timer still ran).

`extendRuntime` (line 389) does clear it, so the only leaks are in `complete`, `fail`, `markCancelled`.

**Smallest safe fix:** in `disarmJob`:

```ts
private disarmJob(job: InternalJob): void {
  if (job.runtimeTimeout) {
    clearTimeout(job.runtimeTimeout);
    job.runtimeTimeout = undefined;
  }
  job.abortController = undefined;
}
```

**Targeted test:** `test/research/jobManager.test.ts` — start a job with `maxTimeMs: 100`, complete it, assert `runtimeTimeout` is undefined and no event-loop ref is held. Use `process._getActiveHandles()` snapshot.

---

#### `[F5]` Force-expire threshold compounds with runtime extensions

`src/research/jobManager.ts:611-615`:

```ts
if (job.startedAt !== undefined && now - job.startedAt > Math.max(this.ttlMs, job.maxTimeMs * 2))
```

`job.maxTimeMs` already includes `totalExtensionsMs` (line 386). For a job extended to 2× original via `extendRuntime`, the force-expire threshold becomes 4× original. Repeated extensions (each capped to 5 min and total capped to 2× original) are protected by the per-job cap, but the threshold math is still wrong: it should be `Math.max(this.ttlMs, job.originalMaxTimeMs * 2)`.

**Smallest safe fix:** use `job.originalMaxTimeMs * 2` (the documented invariant).

**Targeted test:** assert stale-running force-expire fires at `originalMaxTimeMs * 2 + epsilon` not `extended.maxTimeMs * 2`.

---

#### `[F6]` `discoverWithPass` plateau math returns NaN-safe but defers first-pass coverage check

`src/research/discovery.ts:329-336`:

```ts
const newSources = after - before;
const plateau = before > 0 && newSources / before < 0.05;
```

`before > 0` short-circuits the NaN path on pass 1 (before=0), but the loop continues when pass 1 adds zero candidates — no recovery until all `maxPasses` complete. Combined with the budget exhaustion check at line 302 (only fires when `before >= targetSourceCount`), the discovery loop can spend all passes emitting nothing.

**Smallest safe fix:** add a fast-out after pass 1 if `after === before && targetSourceCount > 0`, e.g.:

```ts
if (pass === 1 && newSources === 0 && targetSourceCount > 0) {
  logger.info({ pass }, 'Discovery pass 1 yielded zero sources — switching strategy');
}
```

**Targeted test:** mock backends returning empty arrays, assert the loop terminates early or falls through to `recoverSubQuestion` within a bounded pass count.

---

#### `[F7]` `sourceRanking.freshnessScore` treats future-dated sources as fresh

`src/research/sourceRanking.ts:98-107`.

`days < 30` returns `1.0` with no lower bound. A `publishedDate` in the future (server clock skew, bug in upstream parser) yields `days = -1` → still passes `days < 30` → `1.0`. Future-dated content should be downweighted or flagged.

**Smallest safe fix:**

```ts
if (days < 0) return 0.1; // future-dated — likely a parser/clock issue
if (days < 30) return 1.0;
```

**Targeted test:** `rankSource` with `publishedDate` set to `now + 86400000` returns `freshnessScore = 0.1`.

---

#### `[F8]` `crawlSeeds` JSDoc duplicated

`src/tools/semanticCrawl.ts:894-896`. Two identical `/** Crawl... */` blocks before `export async function crawlSeeds`. No functional impact but suggests a copy-paste artifact that may hide other duplication.

**Smallest safe fix:** delete one of the duplicate doc lines.

---

#### `[F9]` `applyReranking` fallback path may return fewer than `topK` candidates

`src/tools/semanticCrawl.ts:696-700`:

```ts
} catch (err) {
  logger.warn({ err }, 'Cross-encoder re-ranking failed, ...');
  return candidates.slice(0, topK);
}
```

If `candidates.length < topK` (the rerank call path at `:657-664` returns the input unchanged when `candidates.length <= topK`), this fallback is fine. But this function is only called via `embedAndRank` which never enters this code path when `candidates.length <= topK` because the caller at line 657-664 returns early. The catch branch at `:696-700` is therefore dead code. Not a correctness bug, but consider removing the function or wiring it through.

**Smallest safe fix:** delete `applyReranking` (lines 657-700) — its only call site is the inline rerank block at `:599-641` which already has its own try/catch. Consolidate.

---

#### `[N1]` Synchronous `fs.writeFileSync` / `readFileSync` on deep-research result paths

`src/tools/standalone/deepResearch.ts:500` (`autoSaveResult`), `:521` (`ensureResultLoaded`), `:575` (`handleSave`), `:663-700` (`rehydratePersistentJobs`).

For exhaustive depth, the full `ResearchResult` JSON can be megabytes. Each call blocks the event loop on the MCP transport. Suggested target: convert to async `fs.promises.*` and `fs.promises.readdir` with concurrency control during rehydration. Not a correctness bug.

---

#### `[N2]` `compactResearchResult.writeFullResultToFile` blocks event loop

`src/research/compaction.ts:226-240` (`writeFileSync` of full result with `null, 2` formatting). Same concern as N1. Acceptable for quick/standard depths; problematic for exhaustive.

---

#### `[N3]` `corpusCache.writeCorpus` does single-transaction large inserts

`src/utils/corpusCache.ts:481-532`. `chunks.forEach` issues one INSERT per row inside a transaction. For a 5,000-chunk corpus this is 10,000 statements; better-sqlite3 handles this well, but if `embedTextsBatched` is ever raised above the 5,000 hard cap (`src/tools/semanticCrawl.ts:106`), write time scales linearly. Consider chunked transactions (`for ... begin ... commit every N=500`).

---

#### `[N4]` `semanticCrawl` `embedAndRank` rebuilds BM25 on every query when no cached index

`src/tools/semanticCrawl.ts:451-459`:

```ts
const bm25 =
  opts.bm25Index ??
  buildBm25Index(chunks.map((c) => ({ id: c.url + ':' + String(c.chunkIndex), text: c.text })));
```

When called via the standalone `semantic_crawl` tool, no `bm25Index` is cached — every query rebuilds the index from full corpus text. For 2,000 chunks this is ~50ms of tokenization + Map building. Not a bug; flag as a future optimization.

---

#### `[N5]` `response.findLargeTextFields` uses full TextEncoder encode per string field

`src/tools/response.ts:94-125` calling `estimateBytes` at line 124 (which allocates and encodes the entire string just to count bytes). For large `content` fields (≥8KB threshold but still iterating), this is repeated work per matching key. For `semantic_crawl` results with 30+ chunks, the encoder is invoked many times. Replace with `Buffer.byteLength(str, 'utf-8')` for cheaper byte count.

---

#### `[N6]` `agenticBrowse.fetchPage` has a hardcoded 30s timeout

`src/tools/families/agenticBrowse.ts:54`. No env override. For slow SPA pages, this may cut off valid reads. Consider reading from `process.env.AGENTIC_BROWSE_TIMEOUT_MS ?? 30000`.

---

#### `[N7]` `freshnessScore` and `pathDepthPenalty` interact silently when both `publishedDate` and URL parsing are bad

`src/research/sourceRanking.ts:98-115`. `freshnessScore` returns 0.5 (neutral) for missing date; `pathDepthPenalty` returns 1.0 (best) for invalid URL. Both neutral-best defaults may over-promote sources with no metadata.

---

#### `[N8]` Diff removal of `--pretty false` from `tsc` invocation

`scripts/run-tests.cjs:90-93`. The flag was a no-op (not a real `tsc` option — `tsc` doesn't have `--pretty`; that's an ESLint/Prettier flag). The removal is correct but the original code's presence suggests confusion. No action needed.

---

#### `[N9]` `redditSearch` semantic ranking opt-in gate

`src/tools/redditSearch.ts:170` (after diff):

```ts
if (sort === 'relevance' && cfg.embeddingSidecar.baseUrl && results.length > 0) {
```

The diff added the `sort === 'relevance'` gate. Other sort orders (`top`, `new`, `hot`, etc.) skip semantic ranking even when the sidecar is configured — by design, but worth a comment explaining that semantic ranking is a relevance-only optimization.

---

#### `[N10]` `health.redditOAuthHealth` status flipped to `'healthy'` despite OAuth being optional

`src/health.ts:285-298` (after diff). Status change from `'degraded'` to `'healthy'` when OAuth is missing is correct (OAuth is optional, public JSON API works). But the `message` still says "Reddit may block from cloud/datacenter IPs" — a partial-degradation signal now lives only in the message string. Health consumers reading `status === 'healthy'` will not surface this. Consider a new status `'healthy_with_caveats'` or include `caveats: string[]` in `ToolHealth`.

---

#### `[N11]` `agenticBrowse.documentStore` not bounded by URL size

`src/tools/families/agenticBrowse.ts:29-43`. Stores `content` field for every `browse`/`browse_and_present`/`read` call up to `MAX_DOCUMENTS = 100`. If `safeResponseText` returns a 10MB body (the default limit per AGENTS.md), the store can hold ~1GB of HTML strings. Add a per-entry byte cap or measure `Buffer.byteLength(content)` before insert.

---

## Summary

| Severity               | Count | Items                       |
| ---------------------- | ----- | --------------------------- |
| Blocker                | 1     | plan.md/progress.md missing |
| Fix (correctness/perf) | 9     | F1–F9                       |
| Note (non-blocking)    | 11    | N1–N11                      |

Highest-priority fixes: **F1** (entity decode bug, user-visible) · **F2** (dead duplicate action) · **F3** (cache invalidation race) · **F4** (timer leak) · **F5** (threshold compounding).
