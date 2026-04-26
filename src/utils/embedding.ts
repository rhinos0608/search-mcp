/**
 * Embedding provider dispatch.
 *
 * Routes embedding requests to the configured provider:
 *   - 'sidecar' (default): embedding sidecar service
 *   - 'ollama': Ollama local server
 *   - 'transformers': Transformers.js in-process (Node.js)
 *   - 'openai': OpenAI-compatible API
 *
 * Backward compatible: when EMBEDDING_PROVIDER is unset, falls back to sidecar.
 */

import { loadConfig } from '../config.js';
import { networkError, unavailableError } from '../errors.js';
import {
  embedTexts,
  embedTextsBatched,
  type EmbedRequest,
  type EmbedResponse,
} from '../rag/embedding.js';
import { embedWithOllama, getOllamaConfig } from './ollamaEmbedding.js';
import { embedWithTransformers, getTransformersConfig } from './transformersEmbedding.js';

export type EmbeddingProvider = 'sidecar' | 'ollama' | 'transformers' | 'openai';

const VALID_PROVIDERS = new Set<string>(['sidecar', 'ollama', 'transformers', 'openai']);

/**
 * Get the configured embedding provider.
 * Defaults to 'sidecar' for backward compatibility.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  const provider = process.env.EMBEDDING_PROVIDER?.toLowerCase().trim() ?? 'sidecar';
  if (provider === '') return 'sidecar';
  if (!VALID_PROVIDERS.has(provider)) {
    throw unavailableError(
      `Unknown embedding provider: "${provider}". ` +
        `Valid providers: ${[...VALID_PROVIDERS].join(', ')}`,
    );
  }
  return provider as EmbeddingProvider;
}

/**
 * Embed texts using the configured provider.
 * Wraps all providers with the same EmbedResponse contract.
 */
export async function embedTextsWithProvider(
  request: EmbedRequest,
): Promise<EmbedResponse> {
  const provider = getEmbeddingProvider();

  switch (provider) {
    case 'sidecar': {
      // Existing behavior — delegate to the sidecar module
      return embedTexts(request);
    }

    case 'ollama': {
      const config = getOllamaConfig();
      // Ollama handles its own batching, but we pass through the request
      const mode: 'document' | 'query' = request.mode === 'query' ? 'query' : 'document';
      return embedWithOllama(request.texts, config, mode);
    }

    case 'transformers': {
      const config = getTransformersConfig();
      const mode: 'document' | 'query' = request.mode === 'query' ? 'query' : 'document';
      return embedWithTransformers(request.texts, config, mode);
    }

    case 'openai': {
      // OpenAI-compatible API — typically an OpenAI proxy or compatible endpoint
      return embedWithOpenAICompatible(request);
    }

    default: {
      // Fall back to sidecar for unknown providers (shouldn't reach here)
      return embedTexts(request);
    }
  }
}

/**
 * Embed texts using an OpenAI-compatible API endpoint.
 * Reads EMBEDDING_OPENAI_BASE_URL, EMBEDDING_OPENAI_MODEL, and EMBEDDING_OPENAI_API_KEY.
 */
async function embedWithOpenAICompatible(request: EmbedRequest): Promise<EmbedResponse> {
  const baseUrl = process.env.EMBEDDING_OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const model = process.env.EMBEDDING_OPENAI_MODEL ?? 'text-embedding-3-small';
  const apiKey = process.env.EMBEDDING_OPENAI_API_KEY ?? '';

  if (!apiKey) {
    throw unavailableError(
      'OpenAI embedding provider requires EMBEDDING_OPENAI_API_KEY to be set.',
    );
  }

  const endpoint = `${baseUrl.replace(/\/+$/u, '')}/embeddings`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'search-mcp/1.0',
    },
    body: JSON.stringify({
      model,
      input: request.texts,
      dimensions: request.dimensions,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw networkError(
      `OpenAI embedding API returned HTTP ${String(response.status)}${body ? `: ${body.slice(0, 200)}` : ''}`,
      { statusCode: response.status },
    );
  }

  const data = (await response.json()) as {
    data?: { embedding: number[] }[];
    model?: string;
    usage?: { total_tokens: number };
  };

  if (!data.data || !Array.isArray(data.data)) {
    throw networkError('OpenAI embedding API returned unexpected response shape');
  }

  const embeddings = data.data.map((item) => item.embedding);

  return {
    embeddings,
    model: data.model ?? model,
    modelRevision: '',
    dimensions: embeddings[0]?.length ?? request.dimensions,
    mode: request.mode,
    truncatedIndices: [],
  };
}

/**
 * Embed texts batched using the configured provider.
 */
export async function embedTextsBatchedWithProvider(
  request: EmbedRequest,
): Promise<EmbedResponse> {
  const provider = getEmbeddingProvider();

  // Ollama and OpenAI handle batching internally; sidecar and transformers use our batching
  if (provider === 'ollama') {
    return embedTextsWithProvider(request);
  }

  if (provider === 'openai') {
    return embedTextsWithProvider(request);
  }

  // Sidecar and transformers use the batched wrapper
  return embedTextsBatched(request);
}

/**
 * Check if the configured embedding provider is healthy.
 * Returns null if healthy, or an error message string.
 */
export async function checkEmbeddingHealth(): Promise<string | null> {
  const provider = getEmbeddingProvider();

  switch (provider) {
    case 'sidecar': {
      const config = loadConfig();
      if (!config.embeddingSidecar.baseUrl) {
        return 'Embedding sidecar URL is not configured. Set EMBEDDING_SIDECAR_BASE_URL.';
      }
      // Quick connectivity check
      try {
        const response = await fetch(
          `${config.embeddingSidecar.baseUrl.replace(/\/+$/u, '')}/health`,
          { signal: AbortSignal.timeout(5_000) },
        );
        if (!response.ok) {
          return `Embedding sidecar returned HTTP ${String(response.status)}`;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Cannot connect to embedding sidecar: ${message}`;
      }
      return null;
    }

    case 'ollama': {
      const { checkOllamaHealth } = await import('./ollamaEmbedding.js');
      return checkOllamaHealth(getOllamaConfig());
    }

    case 'transformers': {
      const { checkTransformersHealth } = await import('./transformersEmbedding.js');
      return checkTransformersHealth(getTransformersConfig());
    }

    case 'openai': {
      const apiKey = process.env.EMBEDDING_OPENAI_API_KEY;
      if (!apiKey) {
        return 'OpenAI embedding provider requires EMBEDDING_OPENAI_API_KEY.';
      }
      return null;
    }

    default:
      return null;
  }
}
