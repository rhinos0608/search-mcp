# Design: Cross-Encoder Re-Ranking + Chunking Improvements

**Date:** 2026-04-23
**Status:** Draft

## Overview

Two improvements to the `semantic_crawl` retrieval pipeline, addressing the two largest gaps vs. production RAG systems identified in code review:

1. **Cross-encoder re-ranking** — a two-stage retrieval pattern (bi-encoder for recall, cross-encoder for precision) that is table-stakes in serious retrieval systems.
2. **Improved chunking quality** — stronger boilerplate filtering and a semantic coherence check to eliminate nav/sidebar/footer contamination from chunked content.

## Goals

- Add a local, low-latency cross-encoder re-ranker that runs over the top-30 bi-encoder candidates and returns the top-K re-ranked results.
- The re-ranker is a generic utility (`src/utils/rerank.ts`) usable by any tool, not just semanticCrawl.
- Eliminate nav menu and sidebar contamination from chunks via improved structural filtering + a targeted semantic coherence check.
- Maintain the existing latency profile — re-ranking 30 candidates should add <20ms overhead; chunking improvements should add no measurable latency for the structural layer.

## Non-Goals

- Training or fine-tuning the cross-encoder. We use a pre-trained MS MARCO model as-is.
- Replacing the bi-encoder. The cross-encoder supplements it; it does not replace it.
- Full semantic splitting (LlamaIndex-style topic-shift detection on every paragraph). Our semantic check is a targeted filter on borderline chunks only.

---

## Part 1: Cross-Encoder Re-Ranker

### Architecture

```
Bi-encoder (existing)          Cross-encoder (new)
┌──────────────────┐           ┌──────────────────┐
│ embedding-gemma  │           │ MiniLM-L-6-v2    │
│ 300M, 256d       │           │ ONNX, ~25MB      │
│ cosine sim       │           │ query+doc pair   │
│ all chunks       │           │ top-30 only      │
└────────┬─────────┘           └────────┬─────────┘
         │ top-30                       │ re-scored
         └──────────┐   ┌──────────────┘
                    ▼   ▼
              Final top-K
```

### New files

| File | Purpose |
|---|---|
| `src/utils/rerank.ts` | Generic cross-encoder re-ranking utility |
| `test/rerank.test.ts` | Unit tests |

### Model

- **Model:** `cross-encoder/ms-marco-MiniLM-L-6-v2` (Hugging Face)
- **Format:** ONNX (converted from PyTorch, quantized to int8 for size)
- **Size:** ~25MB
- **Input:** Query-document pairs, tokenized with `[SEP]` separator, max 512 tokens
- **Output:** Single logit per pair (relevance score, higher = more relevant)
- **Location:** `models/ms-marco-MiniLM-L-6-v2.onnx` (gitignored, downloaded on first use or bundled)

### `src/utils/rerank.ts` API

```typescript
// Lazy-loaded singleton — model loads on first call, cached for session
export async function rerank(
  query: string,
  documents: string[],
  options?: { topK?: number; maxLength?: number }
): Promise<RerankResult[]>

export interface RerankResult {
  index: number;        // original index in input array
  score: number;        // cross-encoder relevance score
  document: string;     // passthrough of input document text
}
```

**Implementation details:**

1. **Model loading:** Lazy `import` of `onnxruntime-node`. Load model from `models/` directory on first call. Cache the `InferenceSession` in a module-level variable. Wrap in a try-catch that gives a clear error if the model file is missing.

2. **Tokenization:** Use `@huggingface/tokenizers` to load the tokenizer config (saved alongside the ONNX model as `tokenizer.json`). Tokenize each query-document pair with:
   - `truncation: true, maxLength: 512`
   - `padding: 'max_length'` for batch inference
   - Output: `input_ids`, `attention_mask`, `token_type_ids` (all `[batch, 512]` int64 tensors)

3. **Inference:** Run each pair through the ONNX model. The model outputs a single logit per pair. Apply no sigmoid/softmax — raw logits from MS MARCO are already monotonic and can be compared directly. Process in batches of 32 (16KB per batch at 512 tokens × int64).

4. **Sorting:** Sort results descending by score. Return top-K (default: same as input length, i.e., return all re-scored).

5. **Performance target:** <15ms for 30 candidates on Apple Silicon / modern x86. The bottleneck is tokenization (~8ms) not inference (~3ms).

### Model distribution

Two options, handled at build/runtime:

- **Option A (recommended):** Bundle the ONNX model + tokenizer in the npm package under `models/`. Size is ~25MB, acceptable for an MCP server that runs locally.
- **Option B:** Download on first use from Hugging Face, cache in `~/.cache/search-mcp/models/`. Fails gracefully with a clear error if offline.

Decision: Option A (bundled). The model is small enough and avoids cold-start network dependency.

### Error handling

- **Model file missing:** Throw `CONFIGURATION_ERROR` with message "Cross-encoder model not found at <path>. Reinstall the package to restore bundled models."
- **ONNX runtime failure:** Wrap inference errors in `TOOL_EXECUTION_ERROR` with sanitized message (no tensor shapes in user-facing error).
- **Empty documents array:** Return empty array (no-op).
- **Tokenizer failure:** Throw `TOOL_EXECUTION_ERROR`.

### Integration into semanticCrawl

The pipeline change in `src/tools/semanticCrawl.ts`:

```
BEFORE:
  embed(query) + embed(chunks) → cosine sim → sort → topK

AFTER:
  embed(query) + embed(chunks) → cosine sim → sort → top-30 → rerank(query, top-30 docs) → topK
```

Specifically:
1. After the existing cosine similarity sort, take top-30 instead of topK.
2. Extract the text from each of the 30 candidates.
3. Call `rerank(query, texts, { topK: params.topK })`.
4. Map the re-ranked results back to the original chunk objects (using the `index` field).
5. Return the final top-K.

The `topK` parameter on the tool schema stays the same — users don't need to know about the intermediate top-30.

---

## Part 2: Chunking Improvements

### 2A. Improved Structural Boilerplate Filter

Extend `isBoilerplate()` in `src/chunking.ts` with additional heuristics:

**New heuristic: Repeated navigation patterns**
- If >50% of lines in a chunk contain `>` separated link text (breadcrumb patterns like `Home > Docs > API`), mark as boilerplate.
- Regex: `/>?\s*\[.+?\]\(.+?\)\s*>?\s*$/` — matches lines that are primarily markdown links separated by `>`.

**New heuristic: High repetition across chunks**
- After chunking all sections from a page, compute a set of "suspect" chunks: those that have >60% line overlap with at least 2 other chunks from the same page. These are likely repeated nav elements that appear in multiple sections.
- Implementation: For each chunk, compute a normalized line set. Compare against other chunks' line sets. If Jaccard similarity > 0.6 with 2+ other chunks, flag as boilerplate.
- This catches nav menus that are structurally embedded in the content (not in a separate `<nav>` tag).

**New heuristic: Short-line + link-heavy refinement**
- Current: avg words/line < 4 with >5 non-empty lines.
- Tighten: if avg words/line < 3 AND >30% of lines are pure link lines (markdown link is >80% of line content), mark as boilerplate. This catches sidebar-style link lists that just barely miss the current threshold.

### 2B. Semantic Coherence Check (Borderline Chunks Only)

For chunks that pass the structural filter but are "borderline" — link density in [0.2, 0.4) OR avg words/line in [3, 5) — run a quick semantic check:

1. **Compute page centroid:** After all chunks from a page are embedded, compute the mean embedding vector across all chunks. This represents the "topic" of the page.

2. **Score each borderline chunk:** Cosine similarity between the borderline chunk's embedding and the page centroid.

3. **Threshold:** If a borderline chunk's similarity to the centroid is <0.3 (on a 0-1 scale), flag it as off-topic/boilerplate and exclude it.

4. **Why only borderline chunks:** Clearly-content chunks and clearly-boilerplate chunks are already handled by the structural filter. The semantic check is only for the ~10-20% of chunks in the gray zone. This keeps the latency impact near zero since we're already computing embeddings for all chunks anyway.

**Key insight:** The semantic crawl pipeline already embeds every chunk. The page centroid is free — it's just a vector average. The cosine similarity check adds ~0.1ms per borderline chunk (vector dot product). Total overhead: negligible.

### Modified chunking pipeline

```
BEFORE:
  parseSections → mergeShortSections → splitGroup → postProcessChunks → filter(isBoilerplate)

AFTER:
  parseSections → mergeShortSections → splitGroup → postProcessChunks → filter(isBoilerplate [improved]) → filter(semanticCoherence [borderline only])
```

The semantic coherence check happens after embedding (it needs the embedding vectors), so it's integrated into the semanticCrawl handler rather than the chunking module. The structural improvements stay in `chunking.ts`.

### Changes to `src/chunking.ts`

- Update `isBoilerplate()` signature to remain synchronous (structural checks only).
- Add new heuristic functions: `isBreadcrumbNav()`, `isRepeatedAcrossSiblings()`.
- The `isRepeatedAcrossSiblings` check needs access to sibling chunks, so the filtering call in semanticCrawl changes from `chunks.filter(c => !isBoilerplate(c))` to a new `filterBoilerplateWithContext(chunks)` that passes the full chunk set.

### Changes to `src/tools/semanticCrawl.ts`

- After embedding all chunks, compute page centroid.
- Identify borderline chunks (those that passed structural filter but have link density in [0.2, 0.4) or avg words/line in [3, 5)).
- Exclude borderline chunks with centroid similarity < 0.3.
- Then proceed to re-ranking.

---

## Data Flow (Complete Pipeline)

```
URL
  → webCrawl (crawl4ai)
  → For each page:
      → chunkMarkdown (improved structural filter)
      → deduplicateChunks (SHA-256, existing)
  → embedTextsBatched(chunks) + embedTexts(query) [parallel]
  → For each page: semanticCoherenceCheck(centroid, borderline chunks) → exclude
  → cosineSimilarity(query, chunks) → sort → top-30
  → rerank(query, top-30 texts) → top-K
  → Return results
```

## Testing Strategy

### Re-ranker tests (`test/rerank.test.ts`)

| Test | What it verifies |
|---|---|
| Re-ranks relevant doc above irrelevant | Query "python web framework" ranks Flask doc above cooking recipe |
| Preserves document text in output | `result.document` matches input |
| topK parameter works | Returns exactly K results |
| Empty documents returns empty | No crash on empty input |
| Single document returns single result | Edge case |
| Score ordering is descending | Scores are monotonically decreasing |
| Model not found throws CONFIGURATION_ERROR | Missing model file gives clear error |

Note: Re-ranker tests require the ONNX model file. Tests will be skipped in CI if model is absent (conditional describe block).

### Chunking tests (additions to `test/chunking.test.ts`)

| Test | What it verifies |
|---|---|
| Breadcrumb nav is filtered | `Home > Docs > API > ...` pattern chunk is removed |
| Sidebar link list filtered | Chunk with >80% link lines is removed |
| Repeated nav across sections filtered | Same nav block appearing in multiple sections is deduplicated |
| Content with moderate links preserved | Article with inline links is NOT filtered |
| Tightened short-line heuristic | Chunks with avg <3 words/line + >30% pure links are filtered |

### Semantic coherence tests (integration tests in `test/semanticCrawl.test.ts`)

| Test | What it verifies |
|---|---|
| Off-topic chunk excluded | A chunk about "cookie policy" on a Python docs page is excluded |
| On-topic borderline chunk preserved | A chunk about "Python installation" on a Python docs page is preserved |
| Non-borderline chunks unaffected | Chunks with low link density pass through regardless of centroid distance |

## Configuration

No new config parameters for users. The re-ranker is always-on when the model file is present. The chunking improvements are always-on.

Internal constants (not user-facing):
- `RERANK_CANDIDATES = 30` — number of bi-encoder candidates to re-rank
- `RERANK_BATCH_SIZE = 32` — ONNX inference batch size
- `RERANK_MAX_TOKENS = 512` — max tokens per query-doc pair
- `BOILERPLATE_CENTROID_THRESHOLD = 0.3` — min cosine similarity to page centroid
- `BREADCRUMB_LINK_RATIO = 0.5` — breadcrumb detection threshold
- `REPEATED_CHUNK_JACCARD = 0.6` — cross-chunk repetition threshold

## Error Handling

| Error | Handling |
|---|---|
| ONNX model file missing | `CONFIGURATION_ERROR` — clear message, suggests reinstall |
| ONNX inference crash | `TOOL_EXECUTION_ERROR` — sanitized, no tensor shapes |
| Tokenizer load failure | `TOOL_EXECUTION_ERROR` |
| Empty candidates after re-ranking | Return empty results (not an error) |
| Semantic check on unembedded chunk | Defensive: skip the check (chunk passes through) |
