import { logger } from '../logger.js';
import { assertSafeUrl, safeResponseJson } from '../httpGuards.js';
import { ToolCache, cacheKey } from '../cache.js';
import { retryWithBackoff } from '../retry.js';
import { assertRateLimitOk, getTracker } from '../rateLimit.js';
import { ToolError, unavailableError } from '../errors.js';
import type { SearchResult } from '../types.js';

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';

const cache = new ToolCache<SearchResult[]>({ maxSize: 200, ttlMs: 60 * 60 * 1000 });

interface BraveDeepButton {
  title?: string;
  url?: string;
}

interface BraveArticle {
  author?: string;
  publishedDate?: string;
  publisher?: string;
}

interface BraveProduct {
  price?: string;
  currency?: string;
  availability?: string;
}

interface BraveRating {
  ratingValue?: number;
  ratingCount?: number;
  bestRating?: number;
}

interface BraveFaq {
  question?: string;
  answer?: string;
}

interface BraveReview {
  author?: string;
  reviewBody?: string;
}

interface BraveVideo {
  duration?: number;
  views?: number;
  creator?: string;
}

interface BraveMovie {
  directors?: string[];
  actors?: string[];
  genre?: string;
}

interface BraveBook {
  author?: string;
  isbn?: string;
  rating?: number;
}

interface BraveSoftware {
  applicationSuite?: string;
  operatingSystem?: string;
  rating?: number;
}

interface BraveCreativeWork {
  author?: string;
  datePublished?: string;
}

interface BraveLocation {
  name?: string;
  address?: string;
  rating?: number;
}

interface BraveQa {
  question?: string;
  answer?: string;
}

interface BraveOrganization {
  name?: string;
  description?: string;
}

interface BraveMusicRecording {
  artist?: string;
  album?: string;
  releaseDate?: string;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  page_age?: string;
  page_fetched?: string;
  extra_snippets?: string[];
  deep_results?: { buttons?: BraveDeepButton[] };
  meta_url?: { hostname?: string };
  language?: string;
  thumbnail?: { src?: string; original?: string; logo?: boolean };
  article?: BraveArticle;
  product?: BraveProduct;
  rating?: BraveRating;
  faq?: BraveFaq;
  review?: BraveReview;
  video?: BraveVideo;
  movie?: BraveMovie;
  book?: BraveBook;
  software?: BraveSoftware;
  creative_work?: BraveCreativeWork;
  location?: BraveLocation;
  qa?: BraveQa;
  organization?: BraveOrganization;
  music_recording?: BraveMusicRecording;
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
}

function formatTypedData(r: BraveWebResult): string {
  const parts: string[] = [];

  if (r.language) parts.push(`Language: ${r.language}`);
  if (r.thumbnail?.original) parts.push(`Thumbnail: ${r.thumbnail.original}`);

  if (r.article) {
    const sub: string[] = [];
    if (r.article.author) sub.push(`Author: ${r.article.author}`);
    if (r.article.publisher) sub.push(`Publisher: ${r.article.publisher}`);
    if (r.article.publishedDate) sub.push(`Published: ${r.article.publishedDate}`);
    parts.push(`Article { ${sub.join(', ')} }`);
  }

  if (r.product) {
    const sub: string[] = [];
    if (r.product.price)
      sub.push(`Price: ${r.product.price}${r.product.currency ? ' ' + r.product.currency : ''}`);
    if (r.product.availability) sub.push(`Availability: ${r.product.availability}`);
    parts.push(`Product { ${sub.join(', ')} }`);
  }

  if (r.rating) {
    const val = String(r.rating.ratingValue ?? '?');
    const best = String(r.rating.bestRating ?? '?');
    const count = String(r.rating.ratingCount ?? 0);
    parts.push(`Rating: ${val}/${best} (${count} reviews)`);
  }

  if (r.faq) {
    if (r.faq.question) parts.push(`FAQ Q: ${r.faq.question}`);
    if (r.faq.answer) parts.push(`FAQ A: ${r.faq.answer}`);
  }

  if (r.review) {
    const sub: string[] = [];
    if (r.review.author) sub.push(`Author: ${r.review.author}`);
    if (r.review.reviewBody) sub.push(r.review.reviewBody);
    parts.push(`Review { ${sub.join(', ')} }`);
  }

  if (r.video) {
    const sub: string[] = [];
    if (r.video.creator) sub.push(`Creator: ${r.video.creator}`);
    if (r.video.duration !== undefined) sub.push(`Duration: ${String(r.video.duration)}s`);
    if (r.video.views !== undefined) sub.push(`Views: ${String(r.video.views)}`);
    parts.push(`Video { ${sub.join(', ')} }`);
  }

  if (r.movie) {
    const sub: string[] = [];
    if (r.movie.directors?.length) sub.push(`Directors: ${r.movie.directors.join(', ')}`);
    if (r.movie.actors?.length) sub.push(`Actors: ${r.movie.actors.join(', ')}`);
    if (r.movie.genre) sub.push(`Genre: ${r.movie.genre}`);
    parts.push(`Movie { ${sub.join(', ')} }`);
  }

  if (r.book) {
    const sub: string[] = [];
    if (r.book.author) sub.push(`Author: ${r.book.author}`);
    if (r.book.rating !== undefined) sub.push(`Rating: ${String(r.book.rating)}`);
    if (r.book.isbn) sub.push(`ISBN: ${r.book.isbn}`);
    parts.push(`Book { ${sub.join(', ')} }`);
  }

  if (r.software) {
    const sub: string[] = [];
    if (r.software.applicationSuite) sub.push(`Suite: ${r.software.applicationSuite}`);
    if (r.software.operatingSystem) sub.push(`OS: ${r.software.operatingSystem}`);
    if (r.software.rating !== undefined) sub.push(`Rating: ${String(r.software.rating)}`);
    parts.push(`Software { ${sub.join(', ')} }`);
  }

  if (r.creative_work) {
    const sub: string[] = [];
    if (r.creative_work.author) sub.push(`Author: ${r.creative_work.author}`);
    if (r.creative_work.datePublished) sub.push(`Published: ${r.creative_work.datePublished}`);
    parts.push(`CreativeWork { ${sub.join(', ')} }`);
  }

  if (r.location) {
    const sub: string[] = [];
    if (r.location.name) sub.push(`Name: ${r.location.name}`);
    if (r.location.address) sub.push(`Address: ${r.location.address}`);
    if (r.location.rating !== undefined) sub.push(`Rating: ${String(r.location.rating)}`);
    parts.push(`Location { ${sub.join(', ')} }`);
  }

  if (r.qa) {
    if (r.qa.question) parts.push(`Q&A Q: ${r.qa.question}`);
    if (r.qa.answer) parts.push(`Q&A A: ${r.qa.answer}`);
  }

  if (r.organization) {
    const sub: string[] = [];
    if (r.organization.name) sub.push(`Name: ${r.organization.name}`);
    if (r.organization.description) sub.push(r.organization.description);
    parts.push(`Organization { ${sub.join(', ')} }`);
  }

  if (r.music_recording) {
    const sub: string[] = [];
    if (r.music_recording.artist) sub.push(`Artist: ${r.music_recording.artist}`);
    if (r.music_recording.album) sub.push(`Album: ${r.music_recording.album}`);
    if (r.music_recording.releaseDate) sub.push(`Released: ${r.music_recording.releaseDate}`);
    parts.push(`Music { ${sub.join(', ')} }`);
  }

  return parts.length > 0 ? parts.join('\n') : '';
}

export async function braveSearch(
  query: string,
  apiKey: string,
  limit = 10,
  safeSearch: 'strict' | 'moderate' | 'off' = 'moderate',
): Promise<SearchResult[]> {
  logger.info({ limit, safeSearch }, 'Running Brave search');

  const key = cacheKey('brave', query, String(limit), safeSearch);
  const cached = cache.get(key);
  if (cached !== null) {
    logger.debug({ cacheHit: true }, 'Brave search cache hit');
    return cached;
  }

  await assertRateLimitOk('brave');

  const safeness = safeSearch === 'strict' ? 'strict' : safeSearch === 'off' ? 'off' : 'moderate';

  const params = new URLSearchParams({
    q: query,
    count: String(limit),
    safesearch: safeness,
    extra_snippets: 'true',
  });

  const url = `${BRAVE_API_URL}?${params.toString()}`;
  assertSafeUrl(url);

  const response = await retryWithBackoff(
    async () => {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(15_000),
      });

      getTracker('brave').update(res.headers);

      if (res.status === 429) {
        getTracker('brave').recordLimitHit();
        // Non-retryable inside retry loop — do not hammer rate-limited API
        throw new ToolError('Brave Search API rate limit exceeded (429)', {
          code: 'RATE_LIMIT',
          retryable: false,
          statusCode: 429,
          backend: 'brave',
        });
      }

      if (!res.ok) {
        throw unavailableError(
          `Brave Search API returned ${String(res.status)}: ${res.statusText}`,
          { statusCode: res.status, backend: 'brave' },
        );
      }

      return res;
    },
    { label: 'brave-search', maxAttempts: 3 },
  );

  const body = (await safeResponseJson(response, url)) as BraveSearchResponse;
  const webResults = body.web?.results ?? [];

  const mapped: SearchResult[] = webResults.slice(0, limit).map((r, i) => {
    let domain = '';
    try {
      domain = r.meta_url?.hostname ?? new URL(r.url ?? '').hostname;
    } catch {
      /* invalid URL — leave domain empty */
    }
    const buttons = r.deep_results?.buttons;
    const deepLinks =
      buttons && buttons.length > 0
        ? buttons
            .filter(
              (b): b is BraveDeepButton & { title: string; url: string } =>
                typeof b.title === 'string' && typeof b.url === 'string',
            )
            .map((b) => ({ title: b.title, url: b.url }))
        : null;

    const snippetParts: string[] = [];
    if (r.extra_snippets?.length) snippetParts.push(r.extra_snippets.join('\n\n'));
    const typed = formatTypedData(r);
    if (typed) snippetParts.push(typed);

    return {
      title: r.title ?? '',
      url: r.url ?? '',
      description: r.description ?? '',
      position: i + 1,
      domain,
      source: 'brave' as const,
      age: r.age ?? r.page_age ?? r.page_fetched ?? null,
      extraSnippet: snippetParts.length > 0 ? snippetParts.join('\n\n') : null,
      deepLinks: deepLinks && deepLinks.length > 0 ? deepLinks : null,
    };
  });

  cache.set(key, mapped);
  logger.debug({ count: mapped.length }, 'Brave search complete');
  return mapped;
}
