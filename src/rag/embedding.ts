import { networkError, parseError, unavailableError } from '../errors.js';

export interface EmbedRequest {
  baseUrl: string;
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

export async function embedTexts(request: EmbedRequest): Promise<EmbedResponse> {
  if (!request.baseUrl) {
    throw unavailableError('Embedding sidecar is not configured. Set EMBEDDING_SIDECAR_BASE_URL.');
  }

  const endpoint = `${request.baseUrl.replace(/\/+$/u, '')}/embed`;
  // Sidecar URLs are operator-configured and trusted, so they intentionally do
  // not pass through the SSRF guard used for arbitrary user-supplied URLs.
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

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

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

  if (raw === null || typeof raw !== 'object') {
    throw parseError('Embedding sidecar returned unexpected response shape');
  }

  const data = raw as Partial<EmbedResponse>;
  if (!Array.isArray(data.embeddings)) {
    throw parseError('Embedding sidecar response missing embeddings array');
  }

  return {
    embeddings: data.embeddings,
    model: data.model ?? '',
    modelRevision: data.modelRevision ?? '',
    dimensions: data.dimensions ?? request.dimensions,
    mode: data.mode ?? request.mode,
    truncatedIndices: data.truncatedIndices ?? [],
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
