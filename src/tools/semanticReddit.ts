import { logger } from '../logger.js';
import { redditSearch } from './redditSearch.js';
import { redditComments } from './redditComments.js';
import { chunksFromConversation } from '../rag/adapters/conversation.js';
import type { ConversationCommentInput } from '../rag/adapters/conversation.js';
import { embedTexts, embedTextsBatched } from '../rag/embedding.js';
import { prepareCorpus, retrieveCorpus } from '../rag/pipeline.js';
import type { RetrievalProfileName, RetrievalResponse } from '../rag/types.js';
import type { NormalizedRedditComment, NormalizedRedditMore } from './redditThreadParser.js';
import type { RedditClientOptions } from './redditClient.js';
import { DEFAULT_SEMANTIC_MAX_BYTES, applySemanticByteBudget, formatSemanticBytes } from '../semanticLimits.js';

const COMMENT_FETCH_CONCURRENCY = 3;
const REDDIT_BASE_URL = 'https://www.reddit.com';

export interface SemanticRedditOptions {
  query: string;
  subreddit?: string | undefined;
  sort?: 'relevance' | 'hot' | 'new' | 'top' | undefined;
  timeframe?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all' | undefined;
  maxPosts?: number | undefined;
  commentLimit?: number | undefined;
  embeddingBaseUrl: string;
  embeddingApiToken?: string | undefined;
  embeddingDimensions: number;
  profile?: RetrievalProfileName | undefined;
  topK?: number | undefined;
  maxBytes?: number | undefined;
  clientOptions?: RedditClientOptions | undefined;
}

export interface SemanticRedditResult extends RetrievalResponse {
  postCount: number;
  failedPosts: number;
}

function flattenComments(
  items: (NormalizedRedditComment | NormalizedRedditMore)[],
): NormalizedRedditComment[] {
  const result: NormalizedRedditComment[] = [];
  for (const item of items) {
    if ('body' in item) {
      result.push(item);
      if (item.replies.length > 0) {
        result.push(...flattenComments(item.replies));
      }
    }
  }
  return result;
}

function toConversationInput(comment: NormalizedRedditComment): ConversationCommentInput {
  return {
    id: comment.id,
    body: comment.body,
    author: comment.author,
    permalink: REDDIT_BASE_URL + comment.permalink,
    parentId: comment.parentId,
    metadata: {
      score: comment.score,
      createdUtc: comment.createdUtc,
      depth: comment.depth,
      stickied: comment.stickied,
    },
  };
}

export async function semanticReddit(opts: SemanticRedditOptions): Promise<SemanticRedditResult> {
  const maxPosts = Math.min(opts.maxPosts ?? 10, 25);
  const maxBytes = opts.maxBytes ?? DEFAULT_SEMANTIC_MAX_BYTES;
  const commentLimit = opts.commentLimit ?? 100;
  const sort = opts.sort ?? 'relevance';
  const timeframe = opts.timeframe ?? 'year';
  const clientOptions = opts.clientOptions ?? {};

  const posts = await redditSearch(
    opts.query,
    opts.subreddit ?? '',
    sort,
    timeframe,
    maxPosts,
    clientOptions,
  );

  logger.info(
    { tool: 'semantic_reddit', query: opts.query, postCount: posts.length },
    'Fetching comments',
  );

  const warnings: string[] = [];
  let failedPosts = 0;
  const allComments: ConversationCommentInput[] = [];

  for (let i = 0; i < posts.length; i += COMMENT_FETCH_CONCURRENCY) {
    const batch = posts.slice(i, i + COMMENT_FETCH_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (post) => {
        const result = await redditComments(
          { url: post.permalink, limit: commentLimit },
          clientOptions,
        );
        const flat = flattenComments(result.comments);
        return flat.map(toConversationInput);
      }),
    );

    for (let j = 0; j < settled.length; j++) {
      const outcome = settled[j];
      const post = batch[j];
      if (outcome === undefined || post === undefined) continue;
      if (outcome.status === 'rejected') {
        failedPosts++;
        const msg =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        warnings.push(`Comment fetch failed for "${post.permalink}": ${msg}`);
        logger.warn({ permalink: post.permalink, err: outcome.reason }, 'Comment fetch failed');
      } else {
        allComments.push(...outcome.value);
      }
    }
  }

  const chunks = chunksFromConversation(allComments, { baseUrl: REDDIT_BASE_URL });
  const budgeted = applySemanticByteBudget(chunks, maxBytes);
  if (budgeted.truncated) {
    warnings.push(
      `Comment corpus budget capped at ${formatSemanticBytes(maxBytes)}; ${String(budgeted.droppedCount)} chunks omitted`,
    );
  }

  const budgetedChunks = budgeted.items;

  if (budgetedChunks.length === 0) {
    const corpus = prepareCorpus({ adapter: 'conversation', chunks: [] });
    const response = retrieveCorpus(corpus, {
      query: opts.query,
      topK: opts.topK,
      profile: opts.profile,
    });
    return {
      ...response,
      warnings: [...(response.warnings ?? []), ...warnings],
      postCount: posts.length,
      failedPosts,
    };
  }

  const chunkTexts = budgetedChunks.map((c) => c.text);
  const chunkTitles = budgetedChunks.map((c) => c.section);

  const [docEmbed, queryEmbed] = await Promise.all([
    embedTextsBatched({
      baseUrl: opts.embeddingBaseUrl,
      apiToken: opts.embeddingApiToken,
      texts: chunkTexts,
      mode: 'document',
      dimensions: opts.embeddingDimensions,
      titles: chunkTitles,
    }),
    embedTexts({
      baseUrl: opts.embeddingBaseUrl,
      apiToken: opts.embeddingApiToken,
      texts: [opts.query],
      mode: 'query',
      dimensions: opts.embeddingDimensions,
    }),
  ]);

  const queryEmbedding = queryEmbed.embeddings[0];
  if (!queryEmbedding) {
    throw new Error('Embedding sidecar returned empty query embedding');
  }

  const corpus = prepareCorpus({
    adapter: 'conversation',
    chunks: budgetedChunks,
    embeddings: docEmbed.embeddings,
    model: docEmbed.model,
    dimensions: docEmbed.dimensions,
  });

  const response = retrieveCorpus(corpus, {
    query: opts.query,
    queryEmbedding,
    topK: opts.topK,
    profile: opts.profile,
  });

  return {
    ...response,
    warnings: [...(response.warnings ?? []), ...warnings],
    postCount: posts.length,
    failedPosts,
  };
}
