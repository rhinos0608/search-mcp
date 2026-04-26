/**
 * Transformers.js embedding client for fully in-process, API-key-free embeddings.
 *
 * Uses @xenova/transformers to run ONNX-based embedding models directly in Node.js.
 * No external service required.
 *
 * Usage:
 *   EMBEDDING_PROVIDER=transformers
 *   EMBEDDING_TRANSFORMERS_MODEL=Xenova/all-MiniLM-L6-v2
 *
 * Dependencies:
 *   npm install @xenova/transformers
 */

import { parseError } from '../errors.js';
import type { EmbedResponse } from '../rag/embedding.js';

export interface TransformersEmbedderConfig {
  model: string;
  dimensions?: number | undefined;
}

// Lazy-loaded pipeline instance — singleton across calls
let transformersPipeline: unknown = null;
let loadedModelName = '';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const MAX_BATCH_SIZE = 64; // Transformers.js is memory-intensive, keep batches small

/**
 * Detect if Transformers.js embedding should be used and return config.
 */
export function getTransformersConfig(): TransformersEmbedderConfig {
  return {
    model: process.env.EMBEDDING_TRANSFORMERS_MODEL ?? DEFAULT_MODEL,
    dimensions: process.env.EMBEDDING_DIMENSIONS
      ? Number(process.env.EMBEDDING_DIMENSIONS)
      : undefined,
  };
}

/**
 * Get or create the transformers pipeline (lazy singleton).
 */
export async function getPipeline(modelName: string): Promise<unknown> {
  if (transformersPipeline && loadedModelName === modelName) {
    return transformersPipeline;
  }

  try {
    // Dynamic import — @xenova/transformers is optional
    // @ts-expect-error - Optional dependency, may not be installed
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { pipeline } = await import('@xenova/transformers');

    // Dynamic import — may not be installed
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    transformersPipeline = await pipeline('feature-extraction', modelName, {
      quantized: true,
    });
    loadedModelName = modelName;

    return transformersPipeline;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load Transformers.js pipeline: ${message}. ` +
        'Ensure @xenova/transformers is installed: npm install @xenova/transformers',
    );
  }
}

/**
 * Extract an embedding vector from a Transformers.js pipeline output tensor.
 */
function extractEmbedding(output: unknown): number[] {
  try {
    const tensor = output as {
      data?: Float32Array | number[];
      dims?: number[];
      tolist?: () => number[][];
    };

    // Try mean pooling — most common for sentence embeddings
    if (typeof tensor.tolist === 'function') {
      const list = tensor.tolist();
      if (list.length > 0 && list[0]) {
        return list[0];
      }
    }

    // Fall back to raw data array
    if (tensor.data) {
      const data = tensor.data;
      if (data instanceof Float32Array || Array.isArray(data)) {
        return Array.from(data);
      }
    }

    throw new Error('Cannot extract embedding from transformer output');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw parseError(`Failed to extract embedding: ${message}`);
  }
}

/**
 * Embed texts using Transformers.js (fully in-process).
 * Falls back gracefully if the package is not installed.
 */
export async function embedWithTransformers(
  texts: string[],
  config: TransformersEmbedderConfig,
  mode: 'document' | 'query' = 'document',
): Promise<EmbedResponse> {
  if (texts.length === 0) {
    return {
      embeddings: [],
      model: config.model,
      modelRevision: '',
      dimensions: config.dimensions ?? 384,
      mode,
      truncatedIndices: [],
    };
  }

  const pipe = await getPipeline(config.model);
  const allEmbeddings: number[][] = [];
  const truncatedIndices: number[] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);

    // Call pipeline with the batch
    const output = await (pipe as (texts: string[], options?: Record<string, unknown>) => unknown)(
      batch,
      {
        pooling: 'mean',
        normalize: true,
      },
    );

    // Handle single vs batch output
    if (batch.length === 1) {
      const embedding = extractEmbedding(output);
      allEmbeddings.push(embedding);
    } else {
      const outputArray = output as unknown[];
      for (const item of outputArray) {
        const embedding = extractEmbedding(item);
        allEmbeddings.push(embedding);
      }
    }
  }

  return {
    embeddings: allEmbeddings,
    model: config.model,
    modelRevision: '',
    dimensions: allEmbeddings[0]?.length ?? config.dimensions ?? 384,
    mode,
    truncatedIndices,
  };
}

/**
 * Check if Transformers.js is available (package installed).
 * Returns null if available, or an error message.
 */
export async function checkTransformersHealth(
  config: TransformersEmbedderConfig,
): Promise<string | null> {
  try {
    await getPipeline(config.model);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message;
  }
}
