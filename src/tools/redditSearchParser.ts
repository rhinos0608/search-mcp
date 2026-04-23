import { TRUNCATED_MARKER } from '../httpGuards.js';
import type { RedditPost } from '../types.js';
import { canonicalizeRedditPermalink } from './redditPermalink.js';
import { safeExtractFromMarkdown } from '../utils/elementHelpers.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function parseRedditSearchListing(json: unknown): RedditPost[] {
  const top = asRecord(json);
  const data = asRecord(top?.data);
  const children = data?.children;

  if (!Array.isArray(children)) {
    throw new Error('Unexpected Reddit API response shape');
  }

  return children
    .map((child) => {
      const childRecord = asRecord(child);
      const post = asRecord(childRecord?.data);
      if (!post) return null;

      const rawSelftext = typeof post.selftext === 'string' ? post.selftext.trim() : '';
      const selftext =
        rawSelftext.length > 2000 ? rawSelftext.slice(0, 2000) + TRUNCATED_MARKER : rawSelftext;

      const elements = safeExtractFromMarkdown(selftext);
      return {
        title: typeof post.title === 'string' ? post.title : '',
        url: typeof post.url === 'string' ? post.url : '',
        selftext,
        score: typeof post.score === 'number' ? post.score : 0,
        numComments: typeof post.num_comments === 'number' ? post.num_comments : 0,
        subreddit: typeof post.subreddit === 'string' ? post.subreddit : '',
        author: typeof post.author === 'string' ? post.author : '',
        createdUtc: typeof post.created_utc === 'number' ? post.created_utc : 0,
        permalink:
          typeof post.permalink === 'string' ? canonicalizeRedditPermalink(post.permalink) : '',
        isVideo: typeof post.is_video === 'boolean' ? post.is_video : false,
        ...(elements.length > 0 && { elements }),
      } satisfies RedditPost;
    })
    .filter((post): post is RedditPost => post !== null && Boolean(post.title));
}
