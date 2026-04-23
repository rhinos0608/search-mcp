// src/utils/rerank.ts
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { logger } from '../logger.js';
import { unavailableError } from '../errors.js';

export interface RerankResult {
  /** Original index in the input documents array. */
  index: number;
  /** Cross-encoder relevance score (higher = more relevant). */
  score: number;
  /** Passthrough of the input document text. */
  document: string;
}

interface RerankOptions {
  topK?: number;
  maxLength?: number;
}

const MODEL_DIR = join(process.cwd(), 'models');
const MODEL_PATH = join(MODEL_DIR, 'model.onnx');
const TOKENIZER_PATH = join(MODEL_DIR, 'tokenizer.json');
const DEFAULT_MAX_LENGTH = 512;
const BATCH_SIZE = 32;

interface EncodeResult {
  ids: number[];
  attention_mask: number[];
  token_type_ids?: number[];
}

interface HFTokenizer {
  encode(
    text: string,
    options?: {
      text_pair?: string | null;
      add_special_tokens?: boolean;
      return_token_type_ids?: boolean | null;
    },
  ): EncodeResult;
}

interface SessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, unknown>>;
  inputNames: readonly string[];
  outputNames: readonly string[];
}

interface SessionState {
  session: SessionLike;
  tokenizer: HFTokenizer;
  hasTokenTypeIds: boolean;
  outputName: string;
}

let sessionPromise: Promise<SessionState> | null = null;

async function getSession(): Promise<SessionState> {
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    if (!existsSync(MODEL_PATH)) {
      throw unavailableError(
        `Cross-encoder model not found at ${MODEL_PATH}. ` +
          'Run `npx tsx scripts/download-model.ts` to download it.',
      );
    }
    if (!existsSync(TOKENIZER_PATH)) {
      throw unavailableError(
        `Tokenizer not found at ${TOKENIZER_PATH}. ` +
          'Run `npx tsx scripts/download-model.ts` to download it.',
      );
    }

    const [{ InferenceSession }, { Tokenizer }] = await Promise.all([
      import('onnxruntime-node'),
      import('@huggingface/tokenizers'),
    ]);

    // @huggingface/tokenizers v0.1.x: constructor takes (tokenizerJson, configJson)
    // Pass the full parsed object to avoid stripping fields (e.g., added_tokens_decoder).
    const tokenizerJson: unknown = JSON.parse(readFileSync(TOKENIZER_PATH, 'utf8'));
    const tokenizer = new Tokenizer(
      tokenizerJson as Record<string, unknown>,
      {
        truncation: (tokenizerJson as Record<string, unknown>).truncation as
          | Record<string, unknown>
          | undefined,
        padding: (tokenizerJson as Record<string, unknown>).padding as
          | Record<string, unknown>
          | undefined,
      },
    ) as unknown as HFTokenizer;

    const session = await InferenceSession.create(MODEL_PATH, {
      executionProviders: ['cpu'],
    });

    // Probe the model's actual I/O contract rather than assuming names.
    const inputNames = session.inputNames;
    const outputNames = session.outputNames;
    const hasTokenTypeIds = inputNames.includes('token_type_ids');

    // Use the first output name — cross-encoder exports typically have one output
    // (the score/logit tensor). We log the names so failures are debuggable.
    const outputName = outputNames[0];
    if (!outputName) {
      throw unavailableError('Cross-encoder model has no output nodes');
    }

    logger.info({ inputNames, outputNames, hasTokenTypeIds }, 'Cross-encoder model loaded');

    return {
      session: session as unknown as SessionLike,
      tokenizer,
      hasTokenTypeIds,
      outputName,
    };
  })();

  return sessionPromise;
}

interface TokenizedBatch {
  inputIds: bigint[][];
  attentionMask: bigint[][];
  tokenTypeIds: bigint[][];
}

function tokenizePairs(
  tokenizer: HFTokenizer,
  query: string,
  documents: string[],
  maxLength: number,
): TokenizedBatch {
  const inputIds: bigint[][] = [];
  const attentionMask: bigint[][] = [];
  const tokenTypeIds: bigint[][] = [];

  for (const doc of documents) {
    const encoding = tokenizer.encode(query, {
      text_pair: doc,
      add_special_tokens: true,
      return_token_type_ids: true,
    });

    const ids = encoding.ids.slice(0, maxLength);
    const mask = encoding.attention_mask.slice(0, maxLength);
    const types = (encoding.token_type_ids ?? new Array(ids.length).fill(0)).slice(0, maxLength);

    // Pad to maxLength
    while (ids.length < maxLength) {
      ids.push(0);
      mask.push(0);
      types.push(0);
    }

    inputIds.push(ids.map(BigInt));
    attentionMask.push(mask.map(BigInt));
    tokenTypeIds.push(types.map(BigInt));
  }

  return { inputIds, attentionMask, tokenTypeIds };
}

async function runInference(state: SessionState, batch: TokenizedBatch): Promise<number[]> {
  const ort = await import('onnxruntime-node');
  const batchSize = batch.inputIds.length;
  const seqLen = batch.inputIds[0]?.length ?? 0;

  const flatInputIds = new BigInt64Array(batchSize * seqLen);
  const flatAttentionMask = new BigInt64Array(batchSize * seqLen);
  const flatTokenTypeIds = new BigInt64Array(batchSize * seqLen);

  for (let i = 0; i < batchSize; i++) {
    for (let j = 0; j < seqLen; j++) {
      const idx = i * seqLen + j;
      flatInputIds[idx] = (batch.inputIds[i]?.[j] as bigint | undefined) ?? 0n;
      flatAttentionMask[idx] = (batch.attentionMask[i]?.[j] as bigint | undefined) ?? 0n;
      flatTokenTypeIds[idx] = (batch.tokenTypeIds[i]?.[j] as bigint | undefined) ?? 0n;
    }
  }

  // Build feeds based on what the model actually accepts, not what we assume.
  const feeds: Record<string, unknown> = {
    input_ids: new ort.Tensor('int64', flatInputIds, [batchSize, seqLen]),
    attention_mask: new ort.Tensor('int64', flatAttentionMask, [batchSize, seqLen]),
  };
  if (state.hasTokenTypeIds) {
    feeds.token_type_ids = new ort.Tensor('int64', flatTokenTypeIds, [batchSize, seqLen]);
  }

  const results = await state.session.run(feeds);
  const output = results[state.outputName] as { data: Float32Array } | undefined;
  if (!output?.data) {
    throw unavailableError(
      `Cross-encoder output "${state.outputName}" missing from inference result`,
    );
  }

  const scores: number[] = [];
  for (let i = 0; i < batchSize; i++) {
    scores.push(output.data[i] as number);
  }
  return scores;
}

export async function rerank(
  query: string,
  documents: string[],
  options?: RerankOptions,
): Promise<RerankResult[]> {
  if (documents.length === 0) return [];

  const topK = options?.topK ?? documents.length;
  const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH;

  const state = await getSession();

  const allScores: number[] = [];

  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batchDocs = documents.slice(i, i + BATCH_SIZE);
    const batch = tokenizePairs(state.tokenizer, query, batchDocs, maxLength);
    const scores = await runInference(state, batch);
    allScores.push(...scores);
  }

  const results: RerankResult[] = documents.map((doc, idx) => ({
    index: idx,
    score: allScores[idx] as number,
    document: doc,
  }));

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}
