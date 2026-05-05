/**
 * DiscoveryEngine — parallel multi-backend search for deep research.
 *
 * Phase 2: For each sub-question, executes parallel search across
 * configured backends (web, academic, Reddit, HN, GitHub, Stack Overflow),
 * scores candidates, deduplicates, and returns a ranked source pool.
 *
 * Wraps existing search-mcp tools directly (not via MCP).
 */

import { logger } from '../logger.js';
import { loadConfig } from '../config.js';
import { academicSearch } from '../tools/academicSearch.js';
import { getGitHubRepoSearch } from '../tools/githubRepoSearch.js';
import { hackernewsSearch } from '../tools/hackernewsSearch.js';
import { redditSearch } from '../tools/redditSearch.js';
import { stackoverflowSearch } from '../tools/stackoverflowSearch.js';
import { youtubeSearch } from '../tools/youtubeSearch.js';
import { ResearchStateEngine } from './state.js';
import type { SubQuestion, SourceCandidate, SourceType, SourceEntry } from './types.js';
import type { BudgetTracker } from './state.js';

// ── Configuration ──────────────────────────────────────────────────────────

interface DiscoveryConfig {
   maxCandidatesPerSubQuestion: number;
   maxTotalCandidates: number;
}

const DEFAULT_CONFIG: DiscoveryConfig = {
   maxCandidatesPerSubQuestion: 15,
   maxTotalCandidates: 100,
};

// ── Source scoring weights ──────────────────────────────────────────────────

interface ScoreWeights {
   relevance: number;
   diversity: number;
   freshness: number;
   confidence: number;
}

const DEFAULT_WEIGHTS: ScoreWeights = {
   relevance: 0.35,
   diversity: 0.2,
   freshness: 0.15,
   confidence: 0.3,
};

// ── Domain authority baseline ───────────────────────────────────────────────

const AUTHORITY_DOMAINS = new Set<string>([
   'arxiv.org',
   'github.com',
   'wikipedia.org',
   'docs.python.org',
   'developer.mozilla.org',
   'react.dev',
   'nextjs.org',
   'kubernetes.io',
   'docker.com',
   'aws.amazon.com',
   'cloud.google.com',
   'learn.microsoft.com',
   'pytorch.org',
   'tensorflow.org',
   'nodejs.org',
   'npmjs.com',
   'stackoverflow.com',
]);

// ── Helper: normalize URL for dedup ─────────────────────────────────────────

function normalizeUrlForDedup(url: string): string {
   try {
      const u = new URL(url);
      // Remove trailing slash, www prefix, and common tracking
      const host = u.hostname.replace(/^www\./, '');
      const path = u.pathname.replace(/\/$/, '');
      // Strip fragment and common query params
      return `${host}${path}`;
   } catch {
      return url;
   }
}

// ── Helper: extract domain from URL ─────────────────────────────────────────

function extractDomain(url: string): string {
   try {
      return new URL(url).hostname.replace(/^www\./, '');
   } catch {
      return url;
   }
}

// ── Helper: estimate freshness score (0-1) ──────────────────────────────────

function estimateFreshness(age: string | null): number {
   if (!age) return 0.5; // neutral
   const lower = age.toLowerCase();
   if (lower.includes('hour') || lower.includes('minute')) return 1.0;
   if (lower.includes('day')) return 0.9;
   if (lower.includes('week')) return 0.7;
   if (lower.includes('month')) return 0.4;
   if (lower.includes('year')) return 0.2;
   return 0.5;
}

// ── Helper: compute source confidence prior by type ─────────────────────────

function sourceConfidencePrior(type: SourceType, url: string, _snippet: string): number {
   const domain = extractDomain(url);

   // Boost known authority domains
   if (AUTHORITY_DOMAINS.has(domain)) return 0.85;

   switch (type) {
      case 'academic':
         return 0.8;
      case 'github':
         return 0.75;
      case 'documentation':
         return 0.7;
      case 'news':
         return 0.55;
      case 'web':
         // Check for high-quality signals in URL/snippet
         if (domain.includes('blog.') || domain.includes('engineering.')) return 0.65;
         if (domain.includes('medium.com')) return 0.45;
         return 0.5;
      case 'stackoverflow':
         return 0.6;
      case 'reddit':
      case 'hackernews':
         return 0.4;
      default:
         return 0.5;
   }
}

// ── Helper: sub-question → search query generation ──────────────────────────

function buildSearchQueries(sq: SubQuestion): string[] {
   const queries = [sq.text];
   // Add a shorter version for backends that work better with concise queries
   if (sq.text.length > 80) {
      queries.push(sq.text.slice(0, 80));
   }
   return queries;
}

function buildRedditQuery(sq: SubQuestion): string {
   // Reddit works better with shorter queries
   const text = sq.text.replace(/^(what|how|why|when|where|which|is|are|do|does|can)\s/i, '');
   return text.length > 60 ? text.slice(0, 60) : text;
}

function buildGitHubQuery(sq: SubQuestion): string {
   // GitHub code search prefers keywords over questions
   return sq.text
      .replace(/^(what|how|why|when|where|which|is|are|do|does|can)\s/i, '')
      .replace(/[?]/g, '')
      .trim();
}

// ── Discovery Engine ────────────────────────────────────────────────────────

export class DiscoveryEngine {
   private state: ResearchStateEngine;
   private budget: BudgetTracker;
   private config: DiscoveryConfig;
   private weights: ScoreWeights;

   constructor(
      state: ResearchStateEngine,
      budget: BudgetTracker,
      config?: Partial<DiscoveryConfig>,
   ) {
      this.state = state;
      this.budget = budget;
      this.config = { ...DEFAULT_CONFIG, ...config };
      this.weights = DEFAULT_WEIGHTS;
   }

   /**
    * Run parallel discovery for all given sub-questions.
    * Returns ranked, deduplicated source candidates.
    */
   async discover(subQuestions: SubQuestion[]): Promise<SourceCandidate[]> {
      const allCandidates: SourceCandidate[] = [];

      for (const sq of subQuestions) {
         if (this.budget.isExhausted()) {
            logger.warn({ subQuestion: sq.id }, 'Budget exhausted during discovery');
            break;
         }

         const candidates = await this.discoverForSubQuestion(sq);
         allCandidates.push(...candidates);

         this.state.updateSubQuestionStatus(
            sq.id,
            candidates.length > 0 ? 'in_progress' : 'low_confidence',
         );

         // Cap total candidates by budget profile
         if (allCandidates.length >= this.budget.profile.maxSources) {
            logger.info(
               { maxSources: this.budget.profile.maxSources },
               'Reached max sources from budget profile during discovery',
            );
            break;
         }
      }

      // Score, dedup, rank
      const scored = this.scoreCandidates(allCandidates);
      const deduped = this.deduplicate(scored);
      const ranked = this.rankCandidates(deduped);

      // Convert to source entries and store in state
      for (const candidate of ranked) {
         this.state.addSource(this.candidateToSourceEntry(candidate));
      }

      logger.info(
         { totalCandidates: allCandidates.length, storedSources: ranked.length },
         'Discovery complete',
      );

      return ranked;
   }

   // ── Per sub-question discovery ──────────────────────────────────────────

   private async discoverForSubQuestion(sq: SubQuestion): Promise<SourceCandidate[]> {
      const searches: Promise<SourceCandidate[]>[] = [];

      // Web search (always runs)
      if (sq.preferredSources.includes('web')) {
         searches.push(this.searchWeb(sq));
      }

      // Academic search for technical/literature queries
      if (sq.preferredSources.includes('academic')) {
         searches.push(this.searchAcademic(sq));
      }

      // Reddit for practitioner signals
      if (sq.preferredSources.includes('reddit') || sq.preferredSources.includes('hackernews')) {
         searches.push(this.searchReddit(sq));
         searches.push(this.searchHackerNews(sq));
      }

      // GitHub for implementation evidence
      if (sq.preferredSources.includes('github')) {
         searches.push(this.searchGitHub(sq));
      }

      // Stack Overflow for Q&A evidence
      if (sq.preferredSources.includes('stackoverflow')) {
         searches.push(this.searchStackOverflow(sq));
      }

      if (sq.preferredSources.includes('youtube')) {
         searches.push(this.searchYoutube(sq));
      }

      const results = await Promise.allSettled(searches);
      const candidates: SourceCandidate[] = [];

      for (const result of results) {
         if (result.status === 'fulfilled') {
            candidates.push(...result.value);
         } else {
            logger.warn({ error: result.reason }, 'Discovery search failed for sub-question');
         }
      }

      return candidates;
   }

   // ── Individual search wrappers ──────────────────────────────────────────

   private async searchWeb(sq: SubQuestion): Promise<SourceCandidate[]> {
      if (!this.budget.recordToolCall()) return [];

      const queries = buildSearchQueries(sq);
      const results: SourceCandidate[] = [];

      for (const query of queries) {
         try {
            // Use the lower-level search function that doesn't require deps injection
            // We access the webSearch module directly
            const { webSearch } = await import('../tools/webSearch.js');
            const searchResults = await webSearch(query, 10, 'moderate', false, false);
            for (const sr of searchResults) {
               results.push({
                  title: sr.title,
                  url: sr.url,
                  snippet: sr.description,
                  sourceType: 'web',
                  estimatedQuality: 0.5,
                  estimatedRelevance: 0.5,
                  freshness: sr.age ?? '',
                  reasonForInclusion: `Web search result for: ${sq.text}`,
                  subQuestionId: sq.id,
               });
            }
         } catch (err) {
            logger.warn({ err, subQuestion: sq.id }, 'Web search failed');
         }
      }

      // Tag academic-like URLs
      for (const r of results) {
         const domain = extractDomain(r.url);
         if (
            domain.includes('arxiv.org') ||
            domain.includes('semanticscholar.org') ||
            domain.includes('aclweb.org')
         ) {
            (r as { sourceType: SourceType }).sourceType = 'academic';
         } else if (domain.includes('docs.') || domain.includes('learn.') || domain.includes('dev.')) {
            (r as { sourceType: SourceType }).sourceType = 'documentation';
         }
      }

      return results;
   }

   private async searchAcademic(sq: SubQuestion): Promise<SourceCandidate[]> {
      if (!this.budget.recordToolCall()) return [];

      try {
         const result = await academicSearch(sq.text, 'all', 10, null);
         const papers: { title: string; url: string; abstract?: string; year?: number }[] = (
            result as unknown as {
               papers: { title: string; url: string; abstract?: string; year?: number }[];
            }
         ).papers;
         return papers.map((p) => ({
            title: p.title,
            url: p.url,
            snippet: p.abstract ?? '',
            sourceType: 'academic' as SourceType,
            estimatedQuality: 0.8,
            estimatedRelevance: 0.6,
            freshness: p.year ? `${String(new Date().getFullYear() - p.year)} years ago` : '',
            reasonForInclusion: `Academic paper matching: ${sq.text}`,
            subQuestionId: sq.id,
         }));
      } catch (err) {
         logger.warn({ err, subQuestion: sq.id }, 'Academic search failed');
         return [];
      }
   }

   private async searchReddit(sq: SubQuestion): Promise<SourceCandidate[]> {
      if (!this.budget.recordToolCall()) return [];

      try {
         const query = buildRedditQuery(sq);
         const raw = await redditSearch(query, '', 'relevance', 'year', 10);
         const posts: { title: string; url: string; selftext?: string; created_utc?: number }[] =
            raw as unknown as { title: string; url: string; selftext?: string; created_utc?: number }[];
         return posts.map((p) => ({
            title: p.title,
            url: p.url,
            snippet: p.selftext ?? p.title,
            sourceType: 'reddit' as SourceType,
            estimatedQuality: 0.4,
            estimatedRelevance: 0.5,
            freshness: p.created_utc
               ? `${String(Math.floor((Date.now() / 1000 - p.created_utc) / 86400))} days ago`
               : '',
            reasonForInclusion: `Reddit discussion about: ${sq.text}`,
            subQuestionId: sq.id,
         }));
      } catch (err) {
         logger.warn({ err, subQuestion: sq.id }, 'Reddit search failed');
         return [];
      }
   }

   private async searchHackerNews(sq: SubQuestion): Promise<SourceCandidate[]> {
      if (!this.budget.recordToolCall()) return [];

      try {
         const raw = await hackernewsSearch(sq.text, 'story', 'relevance', null, 10);
         const results: { title?: string; url?: string; text?: string }[] = raw as unknown as {
            title?: string;
            url?: string;
            text?: string;
         }[];
         return results.map((r) => ({
            title: r.title ?? '',
            url: r.url ?? '',
            snippet: r.text ?? r.title ?? '',
            sourceType: 'hackernews' as SourceType,
            estimatedQuality: 0.5,
            estimatedRelevance: 0.5,
            freshness: '',
            reasonForInclusion: `HN discussion about: ${sq.text}`,
            subQuestionId: sq.id,
         }));
      } catch (err) {
         logger.warn({ err, subQuestion: sq.id }, 'HN search failed');
         return [];
      }
   }

   private async searchGitHub(sq: SubQuestion): Promise<SourceCandidate[]> {
      if (!this.budget.recordToolCall()) return [];

      try {
         const query = buildGitHubQuery(sq);
         const raw = await getGitHubRepoSearch(query, undefined, undefined, undefined, undefined, 10);
         // Handle both array and { items: [...] } return shapes, plus nil/malformed responses
         let items: {
            fullName?: string;
            htmlUrl?: string;
            description?: string;
            name?: string;
            url?: string;
         }[];
         if (Array.isArray(raw)) {
            items = raw as unknown as { fullName?: string; htmlUrl?: string; description?: string }[];
         } else if (raw && 'items' in raw && Array.isArray((raw as { items: unknown }).items)) {
            items = (raw as { items: { fullName?: string; htmlUrl?: string; description?: string }[] })
               .items;
         } else {
            logger.warn({ raw }, 'Unexpected GitHub search response shape');
            items = [];
         }
         return items.map((r) => ({
            title: r.fullName ?? r.name ?? '',
            url: r.htmlUrl ?? r.url ?? '',
            snippet: r.description ?? '',
            sourceType: 'github' as SourceType,
            estimatedQuality: 0.7,
            estimatedRelevance: 0.5,
            freshness: '',
            reasonForInclusion: `GitHub repository related to: ${sq.text}`,
            subQuestionId: sq.id,
         }));
      } catch (err) {
         logger.warn({ err, subQuestion: sq.id }, 'GitHub search failed');
         return [];
      }
   }
   private async searchYoutube(sq: SubQuestion): Promise<SourceCandidate[]> {
      if (!this.budget.recordToolCall()) return [];
      try {
         const config = loadConfig();
         const apiKey = config.youtube.apiKey ?? '';
         if (!apiKey) return []; // silently skip if no key
         const videos = await youtubeSearch(sq.text, apiKey, 'relevance', 10);
         return videos.map((v) => ({
            title: v.title,
            url: v.url,
            snippet: v.description,
            sourceType: 'youtube' as SourceType,
            estimatedQuality: 0.4,
            estimatedRelevance: 0.5,
            freshness: v.publishedAt ? `${Math.floor((Date.now() - new Date(v.publishedAt).getTime()) / 86400000)} days ago` : '',
            reasonForInclusion: `YouTube video: ${v.title}`,
            subQuestionId: sq.id,
         }));
      } catch (err) {
         logger.warn({ err, subQuestion: sq.id }, 'YouTube search failed');
         return [];
      }
   }

   private async searchStackOverflow(sq: SubQuestion): Promise<SourceCandidate[]> {
      if (!this.budget.recordToolCall()) return [];

      try {
         const raw = await stackoverflowSearch(sq.text, '', 'relevance', '', false, 10);
         const results: { title?: string; url?: string; body?: string }[] = raw as unknown as {
            title?: string;
            url?: string;
            body?: string;
         }[];
         return results.map((r) => ({
            title: r.title ?? '',
            url: r.url ?? '',
            snippet: r.body ?? r.title ?? '',
            sourceType: 'stackoverflow' as SourceType,
            estimatedQuality: 0.6,
            estimatedRelevance: 0.5,
            freshness: '',
            reasonForInclusion: `Stack Overflow Q&A about: ${sq.text}`,
            subQuestionId: sq.id,
         }));
      } catch (err) {
         logger.warn({ err, subQuestion: sq.id }, 'Stack Overflow search failed');
         return [];
      }
   }

   // ── Scoring ────────────────────────────────────────────────────────────

   private scoreCandidates(candidates: SourceCandidate[]): ScoredCandidate[] {
      return candidates.map((c, _idx, all) => {
         const relevance = c.estimatedRelevance;
         const confidence = sourceConfidencePrior(c.sourceType, c.url, c.snippet);
         const freshness = estimateFreshness(c.freshness);
         const diversity = this.computeDiversity(c, all);

         const totalScore =
            this.weights.relevance * relevance +
            this.weights.confidence * confidence +
            this.weights.freshness * freshness +
            this.weights.diversity * diversity;

         return {
            ...c,
            relevanceScore: relevance,
            diversityScore: diversity,
            freshnessScore: freshness,
            confidenceScore: confidence,
            totalScore,
         };
      });
   }

   private computeDiversity(candidate: SourceCandidate, all: SourceCandidate[]): number {
      const domain = extractDomain(candidate.url);
      const sameDomain = all.filter((c) => extractDomain(c.url) === domain).length;
      // Penalize domains that already have many candidates
      return Math.max(0, 1 - (sameDomain - 1) / Math.max(all.length, 1));
   }

   // ── Dedup ───────────────────────────────────────────────────────────────

   private deduplicate(candidates: ScoredCandidate[]): ScoredCandidate[] {
      const seen = new Map<string, ScoredCandidate>();

      for (const c of candidates) {
         const key = normalizeUrlForDedup(c.url);
         const existing = seen.get(key);

         if (!existing) {
            seen.set(key, c);
         } else if (c.totalScore > existing.totalScore) {
            // Keep the higher-scored version
            seen.set(key, c);
         }
         // Otherwise skip the duplicate
      }

      return Array.from(seen.values());
   }

   // ── Ranking ─────────────────────────────────────────────────────────────

   private rankCandidates(candidates: ScoredCandidate[]): SourceCandidate[] {
      return candidates
         .sort((a, b) => b.totalScore - a.totalScore)
         .slice(0, this.config.maxCandidatesPerSubQuestion * 3) // generous slice
         .map(
            ({
               totalScore: _ts,
               relevanceScore: _rs,
               diversityScore: _ds,
               freshnessScore: _fs,
               confidenceScore: _cs,
               ...rest
            }) => rest,
         );
   }

   // ── Convert candidate → source entry ───────────────────────────────────

   private candidateToSourceEntry(candidate: SourceCandidate): SourceEntry {
      const urlSuffix = candidate.url.length > 40 ? candidate.url.slice(-40) : candidate.url;
      const rawId = `src-${urlSuffix}-${String(Date.now())}`;
      return {
         id: rawId.replace(/[^a-zA-Z0-9_-]/g, '_'),
         title: candidate.title,
         url: candidate.url,
         sourceType: candidate.sourceType,
         sourceConfidencePrior: sourceConfidencePrior(
            candidate.sourceType,
            candidate.url,
            candidate.snippet,
         ),
         domain: extractDomain(candidate.url),
         isPrimary: candidate.sourceType === 'academic' || candidate.sourceType === 'github',
         relevantSubQuestions: [candidate.subQuestionId],
         extractionStatus: 'pending' as const,
         accessDate: new Date().toISOString(),
         subQuestionId: candidate.subQuestionId,
      };
   }
}

// ── Internal types ─────────────────────────────────────────────────────────

interface ScoredCandidate extends SourceCandidate {
   relevanceScore: number;
   diversityScore: number;
   freshnessScore: number;
   confidenceScore: number;
   totalScore: number;
}
