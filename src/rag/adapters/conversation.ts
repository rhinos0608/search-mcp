import type { RagChunk, RawDocument } from '../types.js';

export interface ConversationCommentInput {
  id: string;
  body: string;
  author?: string | undefined;
  permalink?: string | undefined;
  parentId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ConversationAdapterOptions {
  parentContextDepth?: number | undefined;
  baseUrl?: string | undefined;
}

function isDeletedOrRemoved(comment: ConversationCommentInput): boolean {
  const body = comment.body.trim().toLowerCase();
  return body === '[deleted]' || body === '[removed]' || body.length === 0;
}

function absoluteUrl(permalink: string | undefined, baseUrl: string | undefined): string {
  if (permalink === undefined) return baseUrl ?? '';
  if (/^https?:\/\//u.test(permalink)) return permalink;
  if (baseUrl === undefined) return permalink;
  return `${baseUrl.replace(/\/+$/u, '')}/${permalink.replace(/^\/+/u, '')}`;
}

function parentContext(
  comment: ConversationCommentInput,
  byId: Map<string, ConversationCommentInput>,
  depth: number,
): string {
  const parts: string[] = [];
  let parentId = comment.parentId ?? null;
  for (let level = 0; level < depth && parentId !== null; level++) {
    const parent = byId.get(parentId);
    if (parent === undefined || isDeletedOrRemoved(parent)) break;
    parts.unshift(parent.body);
    parentId = parent.parentId ?? null;
  }
  return parts.join('\n');
}

export function documentsFromConversation(comments: ConversationCommentInput[]): RawDocument[] {
  return comments
    .filter((comment) => !isDeletedOrRemoved(comment))
    .map((comment) => ({
      id: comment.id,
      adapter: 'conversation',
      text: comment.body,
      url: comment.permalink ?? comment.id,
      title: null,
      metadata: {
        ...comment.metadata,
        author: comment.author,
        parentId: comment.parentId,
      },
    }));
}

export function chunksFromConversation(
  comments: ConversationCommentInput[],
  options?: ConversationAdapterOptions,
): RagChunk[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const kept = comments.filter((comment) => !isDeletedOrRemoved(comment));
  const contextDepth = options?.parentContextDepth ?? 2;

  return kept.map((comment, index) => {
    const context = parentContext(comment, byId, contextDepth);
    const text = context.length > 0 ? `${context}\n\n${comment.body}` : comment.body;
    return {
      text,
      url: absoluteUrl(comment.permalink, options?.baseUrl),
      section: comment.author ?? 'conversation',
      charOffset: 0,
      chunkIndex: index,
      totalChunks: kept.length,
      metadata: {
        ...comment.metadata,
        adapter: 'conversation',
        commentId: comment.id,
        author: comment.author,
        parentId: comment.parentId,
        parentContext: context,
      },
    };
  });
}
