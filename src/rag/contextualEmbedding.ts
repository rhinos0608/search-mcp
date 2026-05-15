/**
 * Contextual embedding enrichment for RAG chunks.
 *
 * Generates a short situating context for each chunk by calling a local LLM
 * with the chunk's parent document, then produces an enriched embedding text
 * of the form:
 *
 *   <context>\n---\n<chunk text>
 *
 * The enriched text is used for embedding; the original `chunk.text` is preserved
 * as `originalText` for display. When LLM is unavailable or the call fails, the
 * module degrades gracefully to the original chunk text with `enriched = false`.
 *
 * Stage 1: V3.3.0 Extraction Resilience
 */

import { logger } from '../logger.js';
import type { LlmConfig } from '../config.js';
import { callOpenAiChatCompletion } from '../utils/llmChat.js';
import type { CorpusChunk } from '../types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ContextualEnrichment {
  /** Text used for embedding: `<context>\n---\n<chunk>` */
  embedText: string;
  /** Unmodified chunk text (preserved for display). */
  originalText: string;
  /** LLM-generated context, or `''` on failure. */
  context: string;
  /** `true` iff LLM returned a non-empty enriched response. */
  enriched: boolean;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_CONTEXT_TOKENS = 200;
const CONTEXT_TEMPERATURE = 0.3;

// ── Core Enrichment ──────────────────────────────────────────────────────────

/**
 * Enrich a single chunk with LLM-generated contextual context.
 *
 * Calls the configured LLM endpoint (OpenAI-compatible `/v1/chat/completions`)
 * with a structured prompt asking for a 1-2 sentence situating context,
 * then joins `context + "\n---\n" + chunk` as `embedText`.
 *
 * On failure (network error, non-200, missing `choices`, empty content) the
 * function returns `embedText = chunk` with `enriched = false`.
 */
export async function enrichChunkWithContext(
  chunk: string,
  fullDocument: string,
  llm: LlmConfig | undefined,
): Promise<ContextualEnrichment> {
  if (!chunk || chunk.trim().length === 0) {
    throw new Error('Chunk text must not be empty');
  }
  if (!fullDocument || fullDocument.trim().length === 0) {
    throw new Error('Document text must not be empty');
  }

  // No-op path: LLM not configured (needs at least a base URL)
  if (!llm?.baseUrl) {
    return { embedText: chunk, originalText: chunk, context: '', enriched: false };
  }

  const model = llm.provider || 'gpt-4o-mini';

  const systemPrompt =
    'You are a precise technical assistant. Given a document and a chunk from ' +
    'that document, write exactly 1-2 sentences that situate the chunk within the ' +
    'document. Be concise. Do not repeat the chunk content verbatim. Output ONLY ' +
    'the context sentence(s), nothing else.';

  const userPrompt =
    `<document>\n${fullDocument.slice(0, 8000)}\n</document>\n` +
    `<chunk>\n${chunk.slice(0, 2000)}\n</chunk>\n\n` +
    'Write 1-2 sentences of context for this chunk (within the document above).';

  try {
    const response = await callOpenAiChatCompletion({
      baseUrl: llm.baseUrl,
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      ...(llm.apiToken ? { apiToken: llm.apiToken } : {}),
      maxTokens: MAX_CONTEXT_TOKENS,
      temperature: CONTEXT_TEMPERATURE,
    });

    if (!response.success) {
      logger.warn({ error: response.error, status: response.status }, 'LLM contextual enrichment request failed');
      return { embedText: chunk, originalText: chunk, context: '', enriched: false };
    }

    if (!response.content.trim()) {
      logger.debug('LLM returned empty context; falling back to original chunk text');
      return { embedText: chunk, originalText: chunk, context: '', enriched: false };
    }

    const trimmedContext = response.content.trim();
    return {
      embedText: `${trimmedContext}\n---\n${chunk}`,
      originalText: chunk,
      context: trimmedContext,
      enriched: true,
    };
  } catch (err) {
    logger.warn({ err }, 'Contextual enrichment threw; falling back to original chunk text');
    return { embedText: chunk, originalText: chunk, context: '', enriched: false };
  }
}

// ── Batch Processing ──────────────────────────────────────────────────────────

/**
 * Semaphore-based parallel batch enrichment.
 *
 * Processes `chunks` in parallel batches of up to `concurrency` concurrent LLM
 * calls. Each chunk's `embedText` is enriched with its parent document's text
 * looked up from `documents` by URL.
 */
export async function enrichChunksBatched(
  chunks: CorpusChunk[],
  documents: Map<string, string>,
  llm: LlmConfig | undefined,
  concurrency = 5,
): Promise<ContextualEnrichment[]> {
  if (!llm?.baseUrl) {
    // Fast no-op path
    return chunks.map((c) => ({
      embedText: c.text,
      originalText: c.text,
      context: '',
      enriched: false,
    }));
  }

  // Build sequential work list
  interface WorkItem {
    index: number;
    chunk: CorpusChunk;
    docText: string;
  }
  const work: WorkItem[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const docText = documents.get(chunk.url) ?? '';
    work.push({ index: i, chunk, docText });
  }

  // Results array — pre-allocated, parallel writes to distinct indices are safe
  const results: (ContextualEnrichment | undefined)[] = Array.from({ length: work.length });

  // ── Semaphore ────────────────────────────────────────────────────────────
  let permits = concurrency;
  const waiters: (() => void)[] = [];

  function acquireSemaphore(): Promise<void> {
    if (permits > 0) {
      permits--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  }

  function releaseSemaphore(): void {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    permits++;
  }

  // ── Worker pool ──────────────────────────────────────────────────────────
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      await acquireSemaphore();

      const localCursor = cursor++;
      if (localCursor >= work.length) {
        releaseSemaphore();
        return;
      }

      const item = work[localCursor];
      if (item === undefined) {
        releaseSemaphore();
        return;
      }

      try {
        results[item.index] = await enrichChunkWithContext(item.chunk.text, item.docText, llm);
      } catch {
        results[item.index] = {
          embedText: item.chunk.text,
          originalText: item.chunk.text,
          context: '',
          enriched: false,
        };
      } finally {
        releaseSemaphore();
      }
    }
  }

  const workerCount = Math.min(concurrency, work.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  return results.map(
    (result, index) =>
      result ?? {
        embedText: work[index]?.chunk.text ?? '',
        originalText: work[index]?.chunk.text ?? '',
        context: '',
        enriched: false,
      },
  );
}
