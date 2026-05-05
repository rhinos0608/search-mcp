import { loadConfig } from '../config.js';
import { networkError, parseError, unavailableError, timeoutError } from '../errors.js';
import { logger } from '../logger.js';

export interface EmbedRequest {
  baseUrl?: string | undefined;
  texts: string[];
  mode: 'document' | 'query';
  dimensions: number;
  apiToken?: string | undefined;
  titles?: string[] | undefined;
}

export interface EmbedResponse {
  embeddings: number[][];
  model: string;
  modelRevision: string;
  dimensions: number;
  mode: string;
  truncatedIndices: number[];
}

const MAX_EMBEDDING_BATCH = 512;

// ── Response normalizer ──────────────────────────────────────────────────

/**
 * Normalize an embedding response from either the native sidecar shape
 * ({ embeddings: number[][] }) or the OpenAI-compatible shape
 * ({ data: [{ embedding: number[], index: number }] }).
 *
 * Returns the normalized embeddings and the detected provider label.
 * Throws `parseError` with diagnostic detail when neither schema matches.
 */
export function normalizeEmbeddingResponse(
  raw: unknown,
  requestedCount: number,
  expectedDimensions?: number,
): { embeddings: number[][]; provider: 'sidecar' | 'openai-compatible' } {
  if (raw === null || typeof raw !== 'object') {
    const typeLabel = raw === null ? 'null' : typeof raw;
    throw parseError(`Embedding response is not an object (received ${typeLabel})`);
  }

  const obj = raw as Record<string, unknown>;
  const topKeys = Object.keys(obj);

  // ── Shape A: native sidecar { embeddings: number[][], ... } ──
  if (Array.isArray(obj.embeddings)) {
    const embeddings = validateEmbeddingVectors(
      obj.embeddings,
      requestedCount,
      expectedDimensions,
      'sidecar',
    );
    return { embeddings, provider: 'sidecar' };
  }

  // ── Shape B: OpenAI-compatible { data: [{ embedding: number[], index }], ... } ──
  if (Array.isArray(obj.data)) {
    const dataArr = obj.data as unknown[];

    if (dataArr.length > 0) {
      const first = dataArr[0];
      if (
        first === null ||
        typeof first !== 'object' ||
        !('embedding' in first) ||
        !Array.isArray((first as Record<string, unknown>).embedding)
      ) {
        const firstItemKeys =
          first !== null && typeof first === 'object'
            ? Object.keys(first as Record<string, unknown>)
            : [];
        throw parseError(
          `OpenAI-compatible response has data array but data[0].embedding is missing; ` +
            `data[0] keys=[${firstItemKeys.join(',')}]`,
        );
      }
    }

    const embeddings = dataArr.map((item) => {
      if (item !== null && typeof item === 'object' && 'embedding' in item) {
        return (item as Record<string, unknown>).embedding as number[];
      }
      return [] as number[];
    });
    const validated = validateEmbeddingVectors(
      embeddings,
      requestedCount,
      expectedDimensions,
      'openai-compatible',
    );
    return { embeddings: validated, provider: 'openai-compatible' };
  }

  // ── Neither schema matched ──
  throw parseError(
    `Embedding response did not match sidecar or OpenAI-compatible schema; ` +
      `keys=[${topKeys.join(',')}], dataIsArray=${String(Array.isArray(obj.data))}`,
  );
}

/**
 * Validate an array of embedding vectors.
 * Checks count, type, and optionally dimension length.
 */
function validateEmbeddingVectors(
  rawEmbeddings: unknown,
  requestedCount: number,
  expectedDimensions: number | undefined,
  provider: string,
): number[][] {
  if (!Array.isArray(rawEmbeddings)) {
    throw parseError(
      `${provider} response embeddings is not an array (received ${typeof rawEmbeddings})`,
    );
  }

  const embeddings: unknown[] = rawEmbeddings;

  if (embeddings.length !== requestedCount) {
    throw parseError(
      `Expected ${String(requestedCount)} embeddings but received ${String(embeddings.length)} from ${provider}`,
    );
  }

  const result: number[][] = [];

  for (let idx = 0; idx < embeddings.length; idx++) {
    const vec = embeddings[idx];
    if (!Array.isArray(vec)) {
      throw parseError(
        `${provider} response embedding[${String(idx)}] is not an array (received ${typeof vec})`,
      );
    }
    if (vec.length === 0) {
      throw parseError(`${provider} response embedding[${String(idx)}] is an empty vector`);
    }
    const numVec: number[] = [];
    for (let dim = 0; dim < vec.length; dim++) {
      const val: unknown = vec[dim];
      if (typeof val !== 'number' || !isFinite(val)) {
        throw parseError(
          `${provider} response embedding[${String(idx)}][${String(dim)}] is not a finite number (value: ${String(val)})`,
        );
      }
      numVec.push(val);
    }
    result.push(numVec);
  }

  if (expectedDimensions !== undefined && result[0] !== undefined) {
    const actualDim = result[0].length;
    if (actualDim !== expectedDimensions) {
      // Log a warning but don't reject — the caller may truncate or pad
      logger.warn(
        {
          provider,
          expected: expectedDimensions,
          actual: actualDim,
        },
        'Embedding dimension mismatch',
      );
    }
  }

  return result;
}

export async function embedTexts(request: EmbedRequest): Promise<EmbedResponse> {
  const config = loadConfig();
  const provider = config.embeddingSidecar.provider;

  switch (provider) {
    case 'sidecar':
      return embedWithSidecar(request, config.embeddingSidecar.baseUrl);

    case 'ollama': {
      const { embedWithOllama, getOllamaConfig } = await import('../utils/ollamaEmbedding.js');
      const ollamaConfig = getOllamaConfig();
      return embedWithOllama(request.texts, ollamaConfig, request.mode);
    }

    case 'transformers': {
      const { embedWithTransformers, getTransformersConfig } =
        await import('../utils/transformersEmbedding.js');
      const transformersConfig = getTransformersConfig();
      return embedWithTransformers(request.texts, transformersConfig, request.mode);
    }

    case 'openai':
      return embedWithOpenAICompatible(request);

    default:
      return embedWithSidecar(request, config.embeddingSidecar.baseUrl);
  }
}

/**
 * Native sidecar embedding implementation.
 */
async function embedWithSidecar(
  request: EmbedRequest,
  configBaseUrl: string,
): Promise<EmbedResponse> {
  const baseUrl = request.baseUrl ?? configBaseUrl;
  if (!baseUrl) {
    throw unavailableError('Embedding sidecar is not configured. Set EMBEDDING_SIDECAR_BASE_URL.');
  }

  const endpoint = `${baseUrl.replace(/\/+$/u, '')}/embed`;
  const body: {
    texts: string[];
    mode: 'document' | 'query';
    dimensions: number;
    titles?: string[];
  } = {
    texts: request.texts,
    mode: request.mode,
    dimensions: request.dimensions,
  };
  if (request.titles !== undefined && request.titles.length > 0) {
    body.titles = request.titles;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'search-mcp/1.0',
  };
  if (request.apiToken) {
    headers.Authorization = `Bearer ${request.apiToken}`;
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.toLowerCase().includes('timeout') ||
      msg.toLowerCase().includes('aborted') ||
      (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
    ) {
      throw timeoutError(`Embedding sidecar request timed out after 60 seconds (Error: ${msg})`, {
        backend: 'sidecar',
      });
    }
    throw networkError(`Embedding sidecar unreachable: ${msg}`, { backend: 'sidecar' });
  }

  if (!response.ok) {
    throw networkError(`Embedding sidecar returned HTTP ${String(response.status)}`, {
      statusCode: response.status,
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await response.text()) as unknown;
  } catch {
    throw parseError('Embedding sidecar returned unexpected response shape');
  }

  const { embeddings: normalizedEmbeddings } = normalizeEmbeddingResponse(
    raw,
    request.texts.length,
    request.dimensions,
  );

  const data = raw as Record<string, unknown>;

  return {
    embeddings: normalizedEmbeddings,
    model: typeof data.model === 'string' ? data.model : '',
    modelRevision: typeof data.modelRevision === 'string' ? data.modelRevision : '',
    dimensions: typeof data.dimensions === 'number' ? data.dimensions : request.dimensions,
    mode: typeof data.mode === 'string' ? data.mode : request.mode,
    truncatedIndices: Array.isArray(data.truncatedIndices)
      ? data.truncatedIndices.filter(
          (x): x is number => typeof x === 'number' && Number.isFinite(x),
        )
      : [],
  };
}

/**
 * OpenAI-compatible embedding implementation.
 */
async function embedWithOpenAICompatible(request: EmbedRequest): Promise<EmbedResponse> {
  const baseUrl =
    process.env.EMBEDDING_OPENAI_BASE_URL ??
    (request.baseUrl ? `${request.baseUrl.replace(/\/+$/u, '')}/v1` : 'https://api.openai.com/v1');
  const model = process.env.EMBEDDING_OPENAI_MODEL ?? 'text-embedding-3-small';
  const apiKey = (process.env.EMBEDDING_OPENAI_API_KEY ?? request.apiToken ?? '').trim();

  const endpoint = `${baseUrl.replace(/\/+$/u, '')}/embeddings`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'search-mcp/1.0',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: request.texts,
        dimensions: request.dimensions,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.toLowerCase().includes('timeout') ||
      msg.toLowerCase().includes('aborted') ||
      (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
    ) {
      throw timeoutError(`OpenAI embedding request timed out after 30 seconds (Error: ${msg})`, {
        backend: 'openai',
      });
    }
    throw networkError(`OpenAI embedding unreachable: ${msg}`, { backend: 'openai' });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw networkError(
      `OpenAI embedding API returned HTTP ${String(response.status)}${body ? `: ${body.slice(0, 200)}` : ''}`,
      { statusCode: response.status },
    );
  }

  const responseClone = response.clone();
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (err) {
    // Attempt to capture response body for context even if JSON parsing failed
    const body = await responseClone.text().catch(() => 'unreadable');
    throw parseError(
      `OpenAI embedding API returned malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
      {
        statusCode: response.status,
        metadata: {
          textsCount: request.texts.length,
          dimensions: request.dimensions,
          responseBody: body.slice(0, 500),
        },
      },
    );
  }

  const { embeddings } = normalizeEmbeddingResponse(raw, request.texts.length, request.dimensions);

  const data = raw as {
    model?: string;
  };

  return {
    embeddings,
    model: data.model ?? model,
    modelRevision: '',
    dimensions: embeddings[0]?.length ?? request.dimensions,
    mode: request.mode,
    truncatedIndices: [],
  };
}

export async function embedTextsBatched(request: EmbedRequest): Promise<EmbedResponse> {
  const embeddings: number[][] = [];
  const truncatedIndices: number[] = [];
  let lastResponse: EmbedResponse | null = null;

  for (let index = 0; index < request.texts.length; index += MAX_EMBEDDING_BATCH) {
    const batch = await embedTexts({
      ...request,
      texts: request.texts.slice(index, index + MAX_EMBEDDING_BATCH),
      titles: request.titles?.slice(index, index + MAX_EMBEDDING_BATCH),
    });
    embeddings.push(...batch.embeddings);
    truncatedIndices.push(
      ...batch.truncatedIndices.map((truncatedIndex) => index + truncatedIndex),
    );
    lastResponse = batch;
  }

  return {
    embeddings,
    model: lastResponse?.model ?? '',
    modelRevision: lastResponse?.modelRevision ?? '',
    dimensions: lastResponse?.dimensions ?? request.dimensions,
    mode: lastResponse?.mode ?? request.mode,
    truncatedIndices,
  };
}
