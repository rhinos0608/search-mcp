/**
 * Ollama embedding client for local, API-key-free embeddings.
 *
 * Usage:
 *   EMBEDDING_PROVIDER=ollama
 *   EMBEDDING_OLLAMA_BASE_URL=http://localhost:11434
 *   EMBEDDING_OLLAMA_MODEL=nomic-embed-text
 */

import { networkError, parseError } from '../errors.js';
import type { EmbedResponse } from '../rag/embedding.js';

export interface OllamaEmbedderConfig {
  baseUrl: string;
  model: string;
  dimensions?: number | undefined;
}

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'nomic-embed-text';
const MAX_BATCH_SIZE = 512;

/**
 * Detect if Ollama server is available and return config.
 * Falls back to defaults if env vars are not set.
 */
export function getOllamaConfig(): OllamaEmbedderConfig {
  return {
    baseUrl: process.env.EMBEDDING_OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
    model: process.env.EMBEDDING_OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL,
    dimensions: process.env.EMBEDDING_DIMENSIONS
      ? Number(process.env.EMBEDDING_DIMENSIONS)
      : undefined,
  };
}

/**
 * Embed texts using Ollama's /api/embed endpoint.
 * Supports both document and query modes.
 */
export async function embedWithOllama(
  texts: string[],
  config: OllamaEmbedderConfig,
  mode: 'document' | 'query' = 'document',
): Promise<EmbedResponse> {
  if (texts.length === 0) {
    return {
      embeddings: [],
      model: config.model,
      modelRevision: '',
      dimensions: config.dimensions ?? 768,
      mode,
      truncatedIndices: [],
    };
  }

  const endpoint = `${config.baseUrl.replace(/\/+$/u, '')}/api/embed`;

  // Ollama supports batching natively, but we batch conservatively
  const allEmbeddings: number[][] = [];
  const truncatedIndices: number[] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'search-mcp/1.0',
      },
      body: JSON.stringify({
        model: config.model,
        input: batch,
        truncate: true,
        options: {
          ...(config.dimensions ? { embedding_dimensions: config.dimensions } : {}),
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw networkError(
        `Ollama returned HTTP ${String(response.status)}${body ? `: ${body.slice(0, 200)}` : ''}`,
        { statusCode: response.status },
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await response.text()) as unknown;
    } catch {
      throw parseError('Ollama returned unexpected response shape');
    }

    if (raw === null || typeof raw !== 'object') {
      throw parseError('Ollama returned unexpected response shape');
    }

    const data = raw as Record<string, unknown>;

    // Ollama returns { embeddings: number[][], ... }
    if (!Array.isArray(data.embeddings)) {
      throw parseError('Ollama response missing embeddings array');
    }

    const batchEmbeddings = data.embeddings as number[][];

    for (const emb of batchEmbeddings) {
      if (!Array.isArray(emb) || emb.length === 0) {
        throw parseError('Ollama returned malformed embedding vector');
      }
    }

    allEmbeddings.push(...batchEmbeddings);
  }

  return {
    embeddings: allEmbeddings,
    model: config.model,
    modelRevision: '',
    dimensions: allEmbeddings[0]?.length ?? config.dimensions ?? 768,
    mode,
    truncatedIndices,
  };
}

/**
 * Check if Ollama server is reachable with the configured model.
 * Returns null if healthy, or an error message string.
 */
export async function checkOllamaHealth(config: OllamaEmbedderConfig): Promise<string | null> {
  try {
    // First check server health
    const healthResponse = await fetch(`${config.baseUrl.replace(/\/+$/u, '')}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!healthResponse.ok) {
      return `Ollama server at ${config.baseUrl} returned HTTP ${String(healthResponse.status)}`;
    }

    // Check if model is available
    const tagsData = (await healthResponse.json()) as { models?: { name: string }[] };
    const models = tagsData.models ?? [];
    const modelAvailable = models.some(
      (m) => m.name === config.model || m.name.startsWith(config.model + ':'),
    );

    if (!modelAvailable) {
      return `Model "${config.model}" not found. Run: ollama pull ${config.model}`;
    }

    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Cannot connect to Ollama at ${config.baseUrl}: ${message}`;
  }
}
