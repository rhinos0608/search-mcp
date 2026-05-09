/**
 * ResearchTools factory — wraps real search tool implementations into a
 * simplified interface for worker agents.
 *
 * Each method catches errors and returns empty results on failure so that
 * worker agents handle graceful degradation without try/catch.
 */

import { webSearch } from '../tools/webSearch.js';
import { webCrawl } from '../tools/webCrawl.js';
import { webRead } from '../tools/webRead.js';
import { academicSearch } from '../tools/academicSearch.js';
import { getGitHubRepoSearch } from '../tools/githubRepoSearch.js';
import { redditSearch } from '../tools/redditSearch.js';
import { hackernewsSearch } from '../tools/hackernewsSearch.js';
import { youtubeSearch } from '../tools/youtubeSearch.js';
import { getYouTubeTranscript } from '../tools/youtubeTranscript.js';
import { redditComments } from '../tools/redditComments.js';
import { semanticYoutube } from '../tools/semanticYoutube.js';
import { semanticReddit } from '../tools/semanticReddit.js';
import { semanticGitHubCode } from '../tools/semanticGitHubCode.js';
import { searchPubMed } from '../tools/pubmedSearch.js';
import { searchWikipedia } from '../tools/wikipediaSearch.js';
import { stackoverflowSearch as searchStackOverflow } from '../tools/stackoverflowSearch.js';
import { semanticCrawl as realSemanticCrawl } from '../tools/semanticCrawl.js';
import { loadConfig } from '../config.js';
import type { ResearchTools, InteractiveExtractionPlan } from './types.js';
import type { SemanticCrawlChunk } from '../types.js';
import type { BrowserSessionConfig } from '../browser/types.js';

export interface ResearchToolsOptions {
  /** Called before each tool invocation — used for budget tracking / logging. */
  onToolCall?: (tool: string, query: string) => void;
}

/**
 * Create a ResearchTools instance that wraps the real search tool functions.
 *
 * Every method is guarded: errors are caught and return empty arrays (or a
 * blank result for webRead) so callers never need to handle tool-level
 * exceptions.
 */
export function createResearchTools(options?: ResearchToolsOptions): ResearchTools {
  const { onToolCall } = options ?? {};

  return {
    async webSearch(query: string, limit?: number) {
      onToolCall?.('web_search', query);
      try {
        const results = await webSearch(query, limit ?? 10);
        return results.map((r) => ({
          title: r.title,
          url: r.url,
          description: r.description,
          ...(r.age ? { age: r.age } : {}),
          // Pass through rich content from Tavily/Exa to avoid re-fetching
          ...(r.extraSnippet ? { extraSnippet: r.extraSnippet } : {}),
          ...(r.deepLinks ? { deepLinks: r.deepLinks } : {}),
        }));
      } catch {
        return [];
      }
    },

    async webCrawl(url: string, maxPages?: number) {
      onToolCall?.('web_crawl', url);
      try {
        const cfg = loadConfig();
        const result = await webCrawl(url, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken ?? '', {
          strategy: 'bfs',
          maxDepth: 1,
          maxPages: maxPages ?? 1,
          includeExternalLinks: false,
        });
        return result.pages.map((p) => ({
          title: p.title ?? '',
          url: p.url,
          markdown: p.markdown,
        }));
      } catch {
        return [];
      }
    },

    async webRead(url: string) {
      onToolCall?.('web_read', url);
      try {
        const result = await webRead(url);
        return {
          title: result.title ?? '',
          url: result.url,
          markdown: result.textContent,
        };
      } catch {
        return { title: '', url, markdown: '' };
      }
    },

    async academicSearch(query: string, limit?: number) {
      onToolCall?.('academic_search', query);
      try {
        const result = await academicSearch(query, 'all', limit ?? 20);
        return result.papers.map((p) => ({
          title: p.title,
          url: p.url,
          ...(p.abstract ? { abstract: p.abstract } : {}),
          ...(p.year ? { year: p.year } : {}),
        }));
      } catch {
        return [];
      }
    },

    async githubSearch(query: string, limit?: number) {
      onToolCall?.('github_search', query);
      try {
        const result = await getGitHubRepoSearch(
          query,
          undefined,
          undefined,
          undefined,
          undefined,
          limit ?? 30,
        );
        return result.results.map((r) => ({
          fullName: r.repo,
          htmlUrl: r.htmlUrl,
          description: '',
        }));
      } catch {
        return [];
      }
    },

    async redditSearch(query: string, limit?: number) {
      onToolCall?.('reddit_search', query);
      try {
        const results = await redditSearch(query, '', 'relevance', 'year', limit ?? 25);
        return results.map((r) => ({
          title: r.title,
          url: r.url,
          selftext: r.selftext,
          created_utc: r.createdUtc,
          permalink: r.permalink,
        }));
      } catch {
        return [];
      }
    },

    async hackernewsSearch(query: string, limit?: number) {
      onToolCall?.('hackernews_search', query);
      try {
        const results = await hackernewsSearch(query, 'story', 'relevance', null, limit ?? 20);
        return results.map((r) => ({
          title: r.title,
          url: r.url ?? '',
          ...(r.storyText ? { text: r.storyText } : {}),
        }));
      } catch {
        return [];
      }
    },

    // ── YouTube ─────────────────────────────────────────────────────────────
    async youtubeSearch(query: string, limit?: number) {
      onToolCall?.('youtube_search', query);
      try {
        const cfg = loadConfig();
        const results = await youtubeSearch(
          query,
          cfg.youtube.apiKey ?? '',
          'relevance',
          limit ?? 10,
        );
        return results.map((r) => ({
          title: r.title,
          videoId: r.videoId,
          channelTitle: r.channelTitle,
          publishedAt: r.publishedAt,
          url: r.url,
        }));
      } catch {
        return [];
      }
    },

    async youtubeTranscript(videoId: string, language?: string) {
      onToolCall?.('youtube_transcript', videoId);
      try {
        const result = await getYouTubeTranscript(videoId, language ?? 'en');
        return result.transcript.map((seg) => ({
          text: seg.text,
          duration: seg.duration,
          offset: seg.offset,
        }));
      } catch {
        return [];
      }
    },

    // ── Reddit comments ───────────────────────────────────────────────────
    async redditComments(url: string, limit?: number) {
      onToolCall?.('reddit_comments', url);
      try {
        const result = await redditComments({ url }, {});
        const comments = (
          result.comments as { body: string; author: string; permalink: string; depth: number }[]
        )
          .filter(
            (c): c is { body: string; author: string; permalink: string; depth: number } =>
              'body' in c,
          )
          .slice(0, limit ?? 50)
          .map((c) => ({
            body: c.body,
            author: c.author,
            permalink: c.permalink,
            depth: c.depth,
          }));
        return {
          post: {
            title: result.post.title,
            selftext: result.post.selftext,
          },
          comments,
        };
      } catch {
        return { post: { title: '', selftext: '' }, comments: [] };
      }
    },

    // ── Semantic YouTube ──────────────────────────────────────────────────
    async semanticYoutube(
      query: string,
      options?: { maxVideos?: number; channel?: string; topK?: number },
    ) {
      onToolCall?.('semantic_youtube', query);
      try {
        const cfg = loadConfig();
        const result = await semanticYoutube({
          query,
          apiKey: cfg.youtube.apiKey ?? '',
          embeddingBaseUrl: cfg.embeddingSidecar.baseUrl,
          embeddingApiToken: cfg.embeddingSidecar.apiToken ?? '',
          embeddingDimensions: cfg.embeddingSidecar.dimensions,
          maxVideos: options?.maxVideos,
          channel: options?.channel,
          topK: options?.topK ?? 10,
        });
        return {
          chunks: result.results.map((r) => ({
            text: r.item.text,
            videoId: (r.item.metadata?.videoId as string | undefined) ?? '',
            title: r.item.section,
            score: r.score.fused,
            url: r.item.url,
          })),
          videoCount: result.videoCount,
          failedTranscripts: result.failedTranscripts,
          warnings: result.warnings ?? [],
        };
      } catch {
        return { chunks: [], videoCount: 0, failedTranscripts: 0, warnings: [] };
      }
    },

    // ── Semantic Reddit ───────────────────────────────────────────────────
    async semanticReddit(
      query: string,
      options?: { subreddit?: string; maxPosts?: number; topK?: number },
    ) {
      onToolCall?.('semantic_reddit', query);
      try {
        const cfg = loadConfig();
        const result = await semanticReddit({
          query,
          subreddit: options?.subreddit,
          maxPosts: options?.maxPosts,
          embeddingBaseUrl: cfg.embeddingSidecar.baseUrl,
          embeddingApiToken: cfg.embeddingSidecar.apiToken ?? '',
          embeddingDimensions: cfg.embeddingSidecar.dimensions,
          topK: options?.topK ?? 10,
        });
        return {
          chunks: result.results.map((r) => ({
            text: r.item.text,
            postTitle: r.item.section,
            score: r.score.fused,
            url: r.item.url,
          })),
          postCount: result.postCount,
          failedPosts: result.failedPosts,
          warnings: result.warnings ?? [],
        };
      } catch {
        return { chunks: [], postCount: 0, failedPosts: 0, warnings: [] };
      }
    },

    // ── Semantic GitHub Code ──────────────────────────────────────────────
    async semanticGitHubCode(
      query: string,
      repo: string,
      options?: { language?: string; maxFiles?: number; topK?: number },
    ) {
      onToolCall?.('semantic_github_code', query);
      try {
        const result = await semanticGitHubCode({
          query,
          repo,
          language: options?.language,
          maxFiles: options?.maxFiles ?? 50,
          topK: options?.topK ?? 10,
        });
        return {
          results: result.results.map((r) => ({
            path: r.path,
            url: r.url,
            language: r.language,
            ...(r.symbolName !== undefined ? { symbolName: r.symbolName } : {}),
            ...(r.text !== undefined ? { text: r.text } : {}),
            score: r.score.fused,
          })),
          warnings: result.warnings,
        };
      } catch {
        return { results: [], warnings: [] };
      }
    },

    // ── Semantic Crawl ────────────────────────────────────────────────────
    async semanticCrawl(
      url: string,
      query: string,
      options?: { maxPages?: number; topK?: number },
    ) {
      onToolCall?.('semantic_crawl', query);
      try {
        const cfg = loadConfig();
        const result = await realSemanticCrawl(
          {
            source: { type: 'url', url },
            query,
            topK: options?.topK ?? 10,
            maxPages: options?.maxPages ?? 5,
            maxDepth: 1,
            strategy: 'bfs',
            includeExternalLinks: false,
          },
          cfg.crawl4ai,
          cfg.embeddingSidecar.baseUrl,
          cfg.embeddingSidecar.apiToken ?? '',
          cfg.embeddingSidecar.dimensions,
          cfg.raga,
        );
        return {
          chunks: result.chunks.map((c: SemanticCrawlChunk) => ({
            text: c.text,
            url: c.url,
            section: c.section,
            score: c.scores.rrf.normalized,
          })),
          pagesCrawled: result.pagesCrawled,
          warnings: result.warnings ?? [],
        };
      } catch {
        return { chunks: [], pagesCrawled: 0, warnings: [] };
      }
    },
    // ── PubMed ────────────────────────────────────────────────────────────
    async pubmedSearch(query: string, limit?: number) {
      onToolCall?.('pubmed_search', query);
      try {
        return await searchPubMed(query, limit);
      } catch {
        return [];
      }
    },

    // ── Wikipedia ─────────────────────────────────────────────────────────
    async wikipediaSearch(query: string, language?: string) {
      onToolCall?.('wikipedia_search', query);
      try {
        const results = await searchWikipedia(query, language ?? 'en');
        return results.map((r) => ({
          title: r.title,
          link: r.link,
          snippet: r.snippet,
          pageId: r.pageId,
          language: r.language,
        }));
      } catch {
        return [];
      }
    },

    // ── Stack Overflow ─────────────────────────────────────────────────────
    async stackoverflowSearch(query: string, limit?: number) {
      onToolCall?.('stackoverflow_search', query);
      try {
        const cfg = loadConfig();
        const apiKey = cfg.stackexchange.apiKey ?? process.env.STACKEXCHANGE_API_KEY ?? '';
        const results = await searchStackOverflow(
          query,
          apiKey,
          'relevance',
          '',
          false,
          limit ?? 20,
        );
        return results.map((r) => ({
          title: r.title,
          link: r.link,
          bodySnippet: r.body.replace(/<[^>]+>/g, '').slice(0, 500),
          answerCount: r.answerCount,
          score: r.score,
          tags: r.tags,
          isAnswered: r.isAnswered,
        }));
      } catch {
        return [];
      }
    },

    // ── Browser interactive extraction ──────────────────────────────────
    async browserSession(config: BrowserSessionConfig) {
      onToolCall?.(
        'browser_session',
        `viewport:${String(config.viewport.width)}x${String(config.viewport.height)}`,
      );
      try {
        const { browserManager } = await import('../browser/browserManager.js');
        const session = await browserManager.launch(config);
        return { sessionId: session.id };
      } catch {
        return { sessionId: '' };
      }
    },

    async browserExtract(sessionId: string, url: string, plan: InteractiveExtractionPlan) {
      onToolCall?.('browser_extract', url);
      try {
        const { browserManager } = await import('../browser/browserManager.js');
        const { InteractiveBrowserAgent } = await import('./interactiveAgent.js');
        const session = browserManager.getActiveSession();
        if (session?.id !== sessionId) {
          return { content: '', findings: [], sources: [], screenshots: [] };
        }
        const agent = new InteractiveBrowserAgent({
          browser: {
            headless: true,
            viewport: { width: 1280, height: 720 },
            userAgent: '',
            proxyServer: '',
            executablePath: '',
            profile: null,
            stealthEnabled: true,
            rebrowser: false,
            maxSessionTimeMs: 0,
            bypassCSP: false,
            credentials: {},
          },
        });
        const result = await agent.executePlan(url, plan, session);
        // Map InteractiveResult fields to research domain objects
        return {
          content: result.content,
          findings: result.findings.map((f) => ({
            id: `browser-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
            claim: f.text.slice(0, 2000),
            normalizedClaim: f.text.slice(0, 2000),
            subQuestionIds: [],
            sourceIds: [],
            evidenceSummary: '',
            evidenceDirectness: 'near-direct' as const,
            freshnessSensitive: false,
            lastUpdated: new Date().toISOString(),
            claimType: 'secondary' as const,
            createdAt: new Date().toISOString(),
            confidence: f.confidence,
          })),
          sources: [
            {
              id: `browser-src-${String(Date.now())}`,
              url: result.url || url,
              title: result.title || '',
              sourceType: 'browser-interactive' as const,
              domain: (() => {
                try {
                  return new URL(result.url || url).hostname;
                } catch {
                  return '';
                }
              })(),
              isPrimary: true,
              relevantSubQuestions: [],
              extractionStatus: 'extracted' as const,
              subQuestionId: '',
              accessDate: new Date().toISOString(),
            },
          ],
          screenshots: result.screenshots,
        };
      } catch {
        return { content: '', findings: [], sources: [], screenshots: [] };
      }
    },

    async browserClose(sessionId: string) {
      onToolCall?.('browser_close', sessionId);
      try {
        const { browserManager } = await import('../browser/browserManager.js');
        const session = browserManager.getActiveSession();
        if (session?.id === sessionId) {
          await browserManager.close(session);
        }
      } catch {
        // silently ignore close failures
      }
    },
  };
}
