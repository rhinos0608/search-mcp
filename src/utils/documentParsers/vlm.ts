/**
 * Opt-in multimodal (VLM) tier for parsed documents.
 *
 * When `config.documentParsing.multimodal` AND `config.llm.baseUrl` are set,
 * this module sends the extracted figure images (and, as a bounded fallback,
 * a few rasterized pages) to the configured OpenAI-compatible vision endpoint
 * and asks for concise figure descriptions / complex-table transcriptions.
 *
 * Opt-in only: when multimodal is off or the LLM is unconfigured, this returns
 * `[]` immediately with zero LLM calls. Never throws — on any error (canvas
 * missing, LLM failure, no images) it returns `[]` and the caller appends a
 * warning. Concurrency is bounded to keep cost/latency predictable.
 */
import { callOpenAiChatCompletion, type OpenAiChatCompletionOptions } from '../llmChat.js';
import { rasterizePages } from './pdf.js';
import type { ParsedDocument } from './types.js';
import type { SearchConfig } from '../../config.js';

/** Hard cap on the number of images sent to the vision LLM per document. */
const MAX_VISUALS = 4;
/** Bounded number of pages rasterized as a fallback when no figures are embedded. */
const MAX_RASTER_PAGES = 2;
/** Max concurrent vision calls (bounds cost/latency). */
const CONCURRENCY = 2;
/** Per-call LLM budget (ms). */
const VLM_TIMEOUT_MS = 60_000;
/** Max output tokens per figure description. */
const VLM_MAX_TOKENS = 512;

const VLM_PROMPT =
  'Describe this figure or table from a document concisely in Markdown. ' +
  'If it is a figure, summarize what it shows and any key labels or values. ' +
  'If it is a table, transcribe its key rows and columns. ' +
  'Keep the description under ~150 words.';

interface VisualInput {
  data: Uint8Array;
  mime: string;
  label: string;
}

/** Per-visual raw byte budget (before base64 conversion). */
const MAX_VISUAL_BYTES = 4 * 1024 * 1024;
/** Cumulative raw byte budget across all collected visuals. */
const MAX_TOTAL_VISUAL_BYTES = 16 * 1024 * 1024;

/**
 * Typed result of `describeVisuals`. `snippets` holds one markdown snippet per
 * successfully described visual; `warning` is set only when a recoverable VLM
 * failure occurred so the caller can surface it in `ParsedDocument.warnings`.
 */
export interface VisualDescriptionResult {
  snippets: string[];
  warning?: string;
}

/**
 * Describe the visual content of a parsed document via the configured vision LLM.
 *
 * @param doc       Parsed document (embedded figure images + tables).
 * @param pdfBytes  Raw PDF bytes, used to rasterize pages as a fallback.
 * @param cfg       Server config (documentParsing.multimodal + llm).
 * @returns         Typed outcome. `snippets` is empty when multimodal is off,
 *                  the LLM is unconfigured, no visuals fit the budgets, or any
 *                  step fails; `warning` carries the reason on recoverable failure.
 */
export async function describeVisuals(
  doc: ParsedDocument,
  pdfBytes: Uint8Array,
  cfg: SearchConfig,
): Promise<VisualDescriptionResult> {
  // Opt-in only: zero LLM calls when multimodal is off or the LLM is unconfigured.
  if (!cfg.documentParsing.multimodal) return { snippets: [] };
  if (!cfg.llm.baseUrl || cfg.llm.baseUrl.trim() === '') return { snippets: [] };
  if (!cfg.llm.provider || cfg.llm.provider.trim() === '') return { snippets: [] };

  try {
    const visuals = await collectVisuals(doc, pdfBytes);
    if (visuals.length === 0) return { snippets: [] };

    const snippets: string[] = [];
    for (let i = 0; i < visuals.length; i += CONCURRENCY) {
      const batch = visuals.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map((v) => describeOne(v, cfg)));
      for (const snippet of results) {
        if (snippet !== null) snippets.push(snippet);
      }
    }
    return { snippets };
  } catch {
    // Recoverable: preserve the empty-result behavior but report the failure.
    return {
      snippets: [],
      warning: 'Multimodal figure/table description failed; proceeding without visual content.',
    };
  }
}

/**
 * Gather the bounded set of visuals to describe: embedded figure images first,
 * then rasterized pages as a fallback until `MAX_VISUALS` is reached.
 */
async function collectVisuals(doc: ParsedDocument, pdfBytes: Uint8Array): Promise<VisualInput[]> {
  const visuals: VisualInput[] = [];
  let totalBytes = 0;
  for (const img of doc.images) {
    if (visuals.length >= MAX_VISUALS) break;
    if (img.data.length === 0) continue;
    // Budget gates on raw bytes (before the later base64 conversion): skip
    // oversized singles, stop when the cumulative document budget is reached.
    if (img.data.length > MAX_VISUAL_BYTES) continue;
    if (totalBytes + img.data.length > MAX_TOTAL_VISUAL_BYTES) break;
    visuals.push({ data: img.data, mime: img.mime, label: `figure on page ${String(img.page)}` });
    totalBytes += img.data.length;
  }
  if (visuals.length < MAX_VISUALS) {
    // Rasterization is best-effort; returns [] on any failure (canvas missing, etc.).
    const pages = await rasterizePages(pdfBytes, { maxPages: MAX_RASTER_PAGES });
    for (const page of pages) {
      if (visuals.length >= MAX_VISUALS) break;
      if (page.png.length === 0) continue;
      if (page.png.length > MAX_VISUAL_BYTES) continue;
      if (totalBytes + page.png.length > MAX_TOTAL_VISUAL_BYTES) break;
      visuals.push({ data: page.png, mime: 'image/png', label: `page ${String(page.page)}` });
      totalBytes += page.png.length;
    }
  }
  return visuals;
}

/**
 * Send one image to the vision LLM and return a markdown snippet, or null on
 * any failure. Never throws.
 */
async function describeOne(visual: VisualInput, cfg: SearchConfig): Promise<string | null> {
  try {
    const base64 = Buffer.from(visual.data).toString('base64');
    const dataUrl = `data:${visual.mime};base64,${base64}`;
    const options: OpenAiChatCompletionOptions = {
      baseUrl: cfg.llm.baseUrl,
      model: cfg.llm.provider,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `${VLM_PROMPT}\n\nThis is a ${visual.label}.` },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      maxTokens: VLM_MAX_TOKENS,
      temperature: 0.2,
      totalTimeoutMs: VLM_TIMEOUT_MS,
      maxRetries: 1,
    };
    if (cfg.llm.apiToken) options.apiToken = cfg.llm.apiToken;

    const result = await callOpenAiChatCompletion(options);
    if (!result.success) return null;
    const content = result.content.trim();
    return content.length === 0 ? null : content;
  } catch {
    return null;
  }
}
