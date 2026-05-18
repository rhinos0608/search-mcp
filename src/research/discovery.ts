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
import { stackoverflowSearch } from '../tools/stackoverflowSearch.js';
import { youtubeSearch } from '../tools/youtubeSearch.js';
import { getYouTubeTranscript } from '../tools/youtubeTranscript.js';
import { attemptExternalRecovery } from '../utils/externalRecovery.js';
import { searchOpenAlex } from '../tools/openalexSearch.js';
import { searchCrossref } from '../tools/crossrefSearch.js';
import { searchDataCite } from '../tools/dataciteSearch.js';
import { searchRor } from '../tools/rorSearch.js';
import { searchSemanticScholar } from '../tools/semanticScholarSearch.js';
import { searchGdelt } from '../tools/gdeltSearch.js';
import { searchWikidata } from '../tools/wikidataSearch.js';
import type {
  SubQuestion,
  SourceCandidate,
  ScoredCandidate,
  SourceType,
  SourceEntry,
  SearchCluster,
} from './types.js';
import { withRetry } from './retry.js';
import { ResearchStateEngine, BudgetTracker } from './state.js';
import { rankSource, maxPerHostname } from './sourceRanking.js';
import { scoreTextRelevance } from './relevanceClassifier.js';
import {
  classifySourceAuthority,
  inferSourceTypeFromUrl,
  isPrimaryAuthority,
} from './provenance.js';
import type { DeepResearchLlmClient } from './llm/chat.js';
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
}

const DEFAULT_WEIGHTS: ScoreWeights = {
  relevance: 0.4,
  diversity: 0.3,
  freshness: 0.3,
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
  'web.archive.org',
  'webcache.googleusercontent.com',
  'jstor.org',
  'cambridge.org',
  'oxfordacademic.com',
  'tandfonline.com',
  'sagepub.com',
  'wiley.com',
  'springer.com',
  'irs.gov',
  'justice.gov',
  'courtlistener.com',
  'law.justia.com',
  'archive.org',
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

// ── Helper: sub-question → search query generation ──────────────────────────

function buildSearchQueries(sq: SubQuestion): string[] {
  const queries = [sq.text];
  // Add a shorter version for backends that work better with concise queries
  if (sq.text.length > 80) {
    queries.push(sq.text.slice(0, 80));
  }
  return queries;
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

  private llm: DeepResearchLlmClient | undefined;
  private intentCoverage = new Map<string, Set<string>>();
  private sourceEntryCounter = 0;
  private abortSignal: AbortSignal | undefined;
  constructor(
    state: ResearchStateEngine,
    budget: BudgetTracker,
    config?: Partial<DiscoveryConfig>,
    llm?: DeepResearchLlmClient,
    abortSignal?: AbortSignal,
  ) {
    this.abortSignal = abortSignal;
    this.state = state;
    this.budget = budget;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.weights = DEFAULT_WEIGHTS;
    this.llm = llm;
  }

  /**
   * Run parallel discovery for all given sub-questions.
   * Returns ranked, deduplicated source candidates.
   */
  async discover(subQuestions: SubQuestion[]): Promise<SourceCandidate[]> {
    const allCandidates: SourceCandidate[] = [];

    // Fair per-sub-question candidate cap: distribute total budget across questions
    const perSubQuestionCap =
      subQuestions.length > 0
        ? Math.max(1, Math.floor(this.config.maxTotalCandidates / subQuestions.length))
        : this.config.maxTotalCandidates;
    const originalCap = this.config.maxCandidatesPerSubQuestion;
    this.config.maxCandidatesPerSubQuestion = Math.min(originalCap, perSubQuestionCap);

    // Run all sub-question discovery in parallel
    const results = await Promise.allSettled(
      subQuestions.map(async (sq) => {
        if (this.budget.isExhausted()) return [] as SourceCandidate[];
        return this.discoverForSubQuestion(sq);
      }),
    );

    // Restore original cap
    this.config.maxCandidatesPerSubQuestion = originalCap;

    // Collect results with recovery for zero-candidate sub-questions
    for (let i = 0; i < results.length; i++) {
      const sq = subQuestions[i];
      if (!sq) continue;
      const result = results[i];
      if (result?.status === 'fulfilled') {
        const candidates = result.value;
        allCandidates.push(...candidates);
        if (candidates.length === 0) {
          // Before hard-demoting, try recovery with broader search
          const recoveryCandidates = await this.recoverSubQuestion(sq);
          allCandidates.push(...recoveryCandidates);
          this.state.updateSubQuestionStatus(
            sq.id,
            recoveryCandidates.length > 0 ? 'in_progress' : 'low_confidence',
          );
        } else {
          this.state.updateSubQuestionStatus(sq.id, 'in_progress');
        }
      } else {
        const reason = result?.status === 'rejected' ? String(result.reason) : 'unknown';
        logger.warn({ error: reason, subQuestion: sq.id }, 'Discovery search failed');
        // Try recovery before hard-demoting
        const recoveryCandidates = await this.recoverSubQuestion(sq);
        allCandidates.push(...recoveryCandidates);
        this.state.updateSubQuestionStatus(
          sq.id,
          recoveryCandidates.length > 0 ? 'in_progress' : 'low_confidence',
        );
      }
    }

    logger.info({ totalCandidates: allCandidates.length }, 'Discovery parallel phase complete');

    // Score, dedup, rank
    const scored = this.scoreCandidates(allCandidates);
    const deduped = this.deduplicate(scored);
    const ranked = this.rankCandidates(deduped);

    // Cap ranked to maxSources from budget profile
    const maxSources = this.budget.profile.maxSources;
    const capped = ranked.slice(0, maxSources);

    // SERP clustering
    const clusters = await this.clusterCandidates(capped);
    if (clusters.length > 0) {
      this.state.addSearchClusters(clusters);
    }

    // Store in state
    for (const candidate of capped) {
      this.state.addSource(this.candidateToSourceEntry(candidate));
    }

    logger.info(
      { totalCandidates: allCandidates.length, storedSources: capped.length },
      'Discovery complete',
    );

    return capped;
  }

  /**
   * Adaptive discovery — runs iterative passes until target source count is met,
   * budget is exhausted, or no new sources are being found.
   *
   * Each pass uses different query strategies:
   *   Pass 1: Original sub-question text (as-is)
   *   Pass 2: LLM-rewritten queries (broader scope, synonyms)
   *   Pass 3: Fragment queries (key terms only)
   */
  async discoverAdaptive(
    subQuestions: SubQuestion[],
    targetSourceCount: number,
  ): Promise<SourceCandidate[]> {
    const allCandidates: SourceCandidate[] = [];
    const existingUrlKeys = new Set<string>();
    // Track which sub-questions produced candidates
    const sqWithCandidates = new Set<string>();

    const maxPasses = 3;
    for (let pass = 1; pass <= maxPasses; pass++) {
      if (this.budget.isExhausted()) break;

      const before = this.state.sourceCount();
      if (before >= targetSourceCount) break;

      logger.info(
        { pass, passCount: maxPasses, currentSources: before, target: targetSourceCount },
        'Adaptive discovery pass',
      );

      // Determine query strategy for this pass
      const passCandidates = await this.discoverWithPass(subQuestions, pass);

      // Track which sub-questions have candidates
      for (const c of passCandidates) {
        sqWithCandidates.add(c.subQuestionId);
      }

      // Filter duplicates against previous passes
      const freshCandidates: SourceCandidate[] = [];
      for (const c of passCandidates) {
        const key = normalizeUrlForDedup(c.url);
        if (!existingUrlKeys.has(key)) {
          existingUrlKeys.add(key);
          freshCandidates.push(c);
        }
      }

      allCandidates.push(...freshCandidates);

      // Check plateau: if <5% new unique candidates, stop early
      const after = this.state.sourceCount();
      const newSources = after - before;
      const plateau = before > 0 && newSources / before < 0.05;
      if (plateau) {
        logger.info({ pass, newSources, before }, 'Adaptive discovery plateau — stopping');
        break;
      }
    }

    // Recovery: for sub-questions that produced zero candidates across all passes
    const sqWithoutCandidates = subQuestions.filter((sq) => !sqWithCandidates.has(sq.id));
    for (const sq of sqWithoutCandidates) {
      logger.info(
        { subQuestion: sq.id },
        'Adaptive: running recovery for zero-candidate sub-question',
      );
      const recoveryCandidates = await this.recoverSubQuestion(sq);
      allCandidates.push(...recoveryCandidates);
      if (recoveryCandidates.length > 0) {
        sqWithCandidates.add(sq.id);
      }
    }

    // Set sub-question status based on success/failure
    for (const sq of subQuestions) {
      if (sqWithCandidates.has(sq.id)) {
        this.state.updateSubQuestionStatus(sq.id, 'in_progress');
      } else if (this.state.getSources(sq.id).length === 0) {
        this.state.updateSubQuestionStatus(sq.id, 'low_confidence');
      }
    }

    logger.info(
      {
        totalCandidates: allCandidates.length,
        withSources: sqWithCandidates.size,
        totalSq: subQuestions.length,
      },
      'Adaptive discovery complete',
    );

    return allCandidates;
  }

  /**
   * Run discovery with a specific query strategy pass.
   * Pass 1: Original sub-question text
   * Pass 2: LLM-rewritten queries (existing rewriteQueries method)
   * Pass 3: Fragment queries (key terms stripped of question words)
   */
  private async discoverWithPass(
    subQuestions: SubQuestion[],
    pass: number,
  ): Promise<SourceCandidate[]> {
    // For passes 2+, modify the sub-question queries to use broader terms
    // We do this by temporarily mutating a copy
    const modifiedSQs = subQuestions.map((sq) => {
      if (pass === 1) {
        // First pass: use original sub-question
        return sq;
      }
      if (pass === 2 && this.llm) {
        // Second pass: LLM can rewrite queries via rewriteQueries —
        // handled per-backend; just pass through
        return sq;
      }
      // Third pass: strip to key terms for broader search
      return {
        ...sq,
        text: sq.text
          .replace(
            /^(what|how|why|when|where|which|is|are|do|does|can|does|did|will|would|should|could|may|might)\s+/i,
            '',
          )
          .replace(/[?.!]+$/g, '')
          .trim()
          .slice(0, 60),
      };
    });

    // Use per-sub-question cap that distributes remaining budget
    const perSubQuestionCap = Math.max(
      3,
      Math.floor(this.config.maxTotalCandidates / Math.max(1, modifiedSQs.length)),
    );
    const originalCap = this.config.maxCandidatesPerSubQuestion;
    this.config.maxCandidatesPerSubQuestion = Math.min(originalCap, perSubQuestionCap);

    const results = await Promise.allSettled(
      modifiedSQs.map(async (sq) => {
        if (this.budget.isExhausted()) return [] as SourceCandidate[];
        return this.discoverForSubQuestion(sq);
      }),
    );

    this.config.maxCandidatesPerSubQuestion = originalCap;

    const allCandidates: SourceCandidate[] = [];
    for (let i = 0; i < results.length; i++) {
      const sq = modifiedSQs[i];
      if (!sq) continue;
      const result = results[i];
      if (result?.status === 'fulfilled') {
        allCandidates.push(...result.value);
      } else {
        logger.warn({ error: result?.reason, subQuestion: sq.id }, 'Adaptive pass search failed');
      }
    }

    // Score, dedup, rank the pass results
    const scored = this.scoreCandidates(allCandidates);
    const deduped = this.deduplicate(scored);
    const ranked = this.rankCandidates(deduped);

    // Store in state
    for (const candidate of ranked) {
      this.state.addSource(this.candidateToSourceEntry(candidate));
    }

    return ranked;
  }

  /**
   * Recovery discovery — spawned when a sub-question initially yields zero candidates.
   * Uses broader query strategies across multiple backends to find anything relevant.
   */
  async recoverSubQuestion(sq: SubQuestion): Promise<SourceCandidate[]> {
    logger.info(
      { subQuestion: sq.id },
      'Running recovery discovery for zero-candidate sub-question',
    );

    if (this.budget.isExhausted()) return [];

    const recoveryCandidates: SourceCandidate[] = [];

    // Strategy 1: Keyword-only web search (strip all question prefixes)
    if (this.budget.recordToolCall()) {
      try {
        const strippedQuery = sq.text
          .replace(
            /^(what|how|why|when|where|which|is|are|do|does|can|did|will|would|should|could|may|might)\s+/i,
            '',
          )
          .replace(/[?.!]+$/g, '')
          .trim();
        const { webSearch } = await import('../tools/webSearch.js');
        const results = await withRetry(
          () => webSearch(strippedQuery, 10, 'moderate', false, false),
          { signal: this.abortSignal },
        );
        for (const sr of results) {
          recoveryCandidates.push({
            title: sr.title,
            url: sr.url,
            snippet: sr.description,
            sourceType: 'web',
            estimatedQuality: 0.5,
            estimatedRelevance: 0.4,
            freshness: sr.age ?? '',
            reasonForInclusion: `Recovery search for: ${sq.text}`,
            subQuestionId: sq.id,
          });
        }
      } catch {
        /* graceful skip */
      }
    }

    // Strategy 2: Academic search as fallback
    if (this.budget.recordToolCall()) {
      try {
        const result = await withRetry(() => academicSearch(sq.text, 'all', 5, null), {
          signal: this.abortSignal,
        });
        const papers =
          (
            result as unknown as {
              papers: { title: string; url: string; abstract?: string }[] | undefined;
            }
          ).papers ?? [];
        for (const p of papers.slice(0, 5)) {
          recoveryCandidates.push({
            title: p.title,
            url: p.url,
            snippet: p.abstract ?? '',
            sourceType: 'academic',
            estimatedQuality: 0.6,
            estimatedRelevance: 0.4,
            freshness: '',
            reasonForInclusion: `Recovery academic search for: ${sq.text}`,
            subQuestionId: sq.id,
          });
        }
      } catch {
        /* graceful skip */
      }
    }

    // Score, dedup, rank remaining
    if (recoveryCandidates.length === 0) return [];

    const scored = this.scoreCandidates(recoveryCandidates);
    const deduped = this.deduplicate(scored);
    const ranked = this.rankCandidates(deduped);

    for (const candidate of ranked) {
      this.state.addSource(this.candidateToSourceEntry(candidate));
    }

    logger.info(
      { subQuestion: sq.id, recoveryCount: ranked.length },
      'Recovery discovery complete',
    );

    return ranked;
  }

  // ── Per sub-question discovery ──────────────────────────────────────────

  private async discoverForSubQuestion(sq: SubQuestion): Promise<SourceCandidate[]> {
    const searches: Promise<SourceCandidate[]>[] = [];

    // Web search (always runs)
    searches.push(this.searchWeb(sq));

    // Reddit for practitioner signals — always attempt (fetch comments for richer context)
    searches.push(this.searchRedditSemantic(sq));

    // YouTube — always attempt (gracefully skips when no API key)
    searches.push(this.searchYoutube(sq));

    // Hacker News — decoupled from reddit; only when explicitly requested
    if (sq.preferredSources.includes('hackernews')) {
      searches.push(this.searchHackerNews(sq));
    }

    // News search (current events)
    if (sq.preferredSources.includes('news')) {
      searches.push(this.searchNews(sq));
    }

    // Academic search for technical/literature queries
    if (sq.preferredSources.includes('academic')) {
      searches.push(this.searchAcademic(sq));
    }

    // GitHub for implementation evidence
    if (sq.preferredSources.includes('github')) {
      searches.push(this.searchGitHub(sq));
    }

    // Stack Overflow for Q&A evidence
    if (sq.preferredSources.includes('stackoverflow')) {
      searches.push(this.searchStackOverflow(sq));
    }

    // Wayback archive search for academic/adjacent articles
    if (sq.preferredSources.includes('academic') || sq.preferredSources.includes('web')) {
      searches.push(this.searchWayback(sq));
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

    // Wikipedia & PubMed (hybrid discovery)
    if (
      sq.classification === 'technical' ||
      sq.classification === 'literature-review' ||
      sq.preferredSources.includes('academic')
    ) {
      const hybridSearches = [this.searchWikipedia(sq), this.searchPubMed(sq)];
      const hybridResults = await Promise.allSettled(hybridSearches);
      for (const hr of hybridResults) {
        if (hr.status === 'fulfilled') {
          candidates.push(...hr.value);
        }
      }
    }

    // Free academic/discovery backends (hybrid discovery)
    if (
      sq.preferredSources.includes('openalex') ||
      sq.preferredSources.includes('crossref') ||
      sq.preferredSources.includes('datacite') ||
      sq.preferredSources.includes('ror') ||
      sq.preferredSources.includes('semantic_scholar') ||
      sq.preferredSources.includes('gdelt') ||
      sq.preferredSources.includes('wikidata')
    ) {
      const freeBackendSearches: Promise<SourceCandidate[]>[] = [];
      if (sq.preferredSources.includes('openalex')) {
        freeBackendSearches.push(this.searchOpenAlex(sq));
      }
      if (sq.preferredSources.includes('crossref')) {
        freeBackendSearches.push(this.searchCrossref(sq));
      }
      if (sq.preferredSources.includes('datacite')) {
        freeBackendSearches.push(this.searchDataCite(sq));
      }
      if (sq.preferredSources.includes('ror')) {
        freeBackendSearches.push(this.searchRor(sq));
      }
      if (sq.preferredSources.includes('semantic_scholar')) {
        freeBackendSearches.push(this.searchSemanticScholar(sq));
      }
      if (sq.preferredSources.includes('gdelt')) {
        freeBackendSearches.push(this.searchGdelt(sq));
      }
      if (sq.preferredSources.includes('wikidata')) {
        freeBackendSearches.push(this.searchWikidata(sq));
      }
      const freeResults = await Promise.allSettled(freeBackendSearches);
      for (const fr of freeResults) {
        if (fr.status === 'fulfilled') {
          candidates.push(...fr.value);
        }
      }
    }

    // Proactively recover archived copies of academic/paywalled articles
    if (candidates.length > 0) {
      const archiveCandidates = await this.recoverAcademicArchives(sq, candidates);
      candidates.push(...archiveCandidates);
    }

    // Track that we attempted general web search for this sub-question
    if (!this.intentCoverage.has(sq.id)) {
      this.intentCoverage.set(sq.id, new Set());
    }
    this.intentCoverage.get(sq.id)?.add('general');

    return candidates;
  }

  // ── Individual search wrappers ──────────────────────────────────────────

  private async searchWeb(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];

    const queries = await this.rewriteQueries(sq);
    const results: SourceCandidate[] = [];

    for (const query of queries) {
      try {
        // Use the lower-level search function that doesn't require deps injection
        // We access the webSearch module directly
        const { webSearch } = await import('../tools/webSearch.js');
        const searchResults = await withRetry(
          () => webSearch(query, 10, 'moderate', false, false),
          { signal: this.abortSignal },
        );
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
      (r as { sourceType: SourceType }).sourceType = inferSourceTypeFromUrl(r.url, r.sourceType);
    }

    return results;
  }

  private async searchNews(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];

    const queries = buildSearchQueries(sq);
    const results: SourceCandidate[] = [];

    for (const query of queries) {
      try {
        const { webSearch } = await import('../tools/webSearch.js');
        const searchResults = await withRetry(
          () => webSearch(query, 10, 'moderate', false, false),
          { signal: this.abortSignal },
        );
        for (const sr of searchResults) {
          results.push({
            title: sr.title,
            url: sr.url,
            snippet: sr.description,
            sourceType: 'news',
            estimatedQuality: 0.6,
            estimatedRelevance: 0.6,
            freshness: sr.age ?? '',
            reasonForInclusion: `News result for: ${sq.text}`,
            subQuestionId: sq.id,
          });
        }
      } catch (err) {
        logger.warn({ err, subQuestion: sq.id }, 'News search failed');
      }
    }

    return results;
  }

  private async rewriteQueries(sq: SubQuestion): Promise<string[]> {
    if (!this.llm) return buildSearchQueries(sq);
    try {
      const { WORKER_REWRITE_QUERY } = await import('./llm/prompts.js');
      const result = await this.llm.callJSON<{
        queries: { q: string; tbs?: string; location?: string }[];
      }>({
        model: 'worker',
        messages: [
          { role: 'system', content: WORKER_REWRITE_QUERY },
          {
            role: 'user',
            content: `Sub-question: ${sq.text}\nClassification: ${sq.classification}\nFreshness requirement: ${sq.freshnessRequirement}`,
          },
        ],
        temperature: 0.3,
      });
      if (result.success) {
        const data = result.data as { isRaw?: unknown; queries?: { q: string }[] };
        if (!('isRaw' in data) && Array.isArray(data.queries) && data.queries.length > 0) {
          return data.queries.map((q) => q.q);
        }
      }
    } catch {
      // fall through
    }
    return buildSearchQueries(sq);
  }

  private async clusterCandidates(
    candidates: {
      title: string;
      url: string;
      snippet: string;
      subQuestionId: string;
    }[],
  ): Promise<SearchCluster[]> {
    if (!this.llm || candidates.length < 3) return [];
    try {
      const { WORKER_CLUSTER } = await import('./llm/prompts.js');
      const items = candidates
        .slice(0, 15)
        .map((c, i) => `[${String(i)}] ${c.title}: ${c.snippet.slice(0, 200)}`)
        .join('\n');
      const result = await this.llm.callJSON<{ clusters: SearchCluster[] }>({
        model: 'worker',
        messages: [
          { role: 'system', content: WORKER_CLUSTER },
          { role: 'user', content: `Search results:\n${items}` },
        ],
        temperature: 0.3,
      });
      if (result.success) {
        const data = result.data as { isRaw?: unknown; clusters?: SearchCluster[] };
        if (!('isRaw' in data) && Array.isArray(data.clusters)) {
          return data.clusters;
        }
      }
    } catch {
      // fall through
    }
    return [];
  }

  private async searchAcademic(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];

    try {
      const result = await withRetry(() => academicSearch(sq.text, 'all', 10, null), {
        signal: this.abortSignal,
      });
      const papers: { title: string; url: string; abstract?: string; year?: number }[] = (
        result as unknown as {
          papers: { title: string; url: string; abstract?: string; year?: number }[];
        }
      ).papers;
      return papers.map((p) => ({
        title: p.title,
        url: p.url,
        snippet: p.abstract ?? '',
        sourceType: 'academic',
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

  private async searchRedditSemantic(sq: SubQuestion): Promise<SourceCandidate[]> {
    // Reddit search now requires a subreddit — discovery has no subreddit context.
    // Skip Reddit source discovery.
    void sq;
    return [];
  }

  private async searchHackerNews(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];

    try {
      const raw = await withRetry(() => hackernewsSearch(sq.text, 'story', 'relevance', null, 10), {
        signal: this.abortSignal,
      });
      const results: { title?: string; url?: string; text?: string }[] = raw as unknown as {
        title?: string;
        url?: string;
        text?: string;
      }[];
      return results.map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.text ?? r.title ?? '',
        sourceType: 'hackernews',
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
      const raw = await withRetry(
        () => getGitHubRepoSearch(query, undefined, undefined, undefined, undefined, 10),
        { signal: this.abortSignal },
      );
      // Handle both array and { items: [...] } return shapes, plus nil/malformed responses
      let items: {
        fullName?: string;
        htmlUrl?: string;
        description?: string;
        name?: string;
        url?: string;
      }[];
      if (Array.isArray(raw)) {
        items = raw;
      } else if ('items' in raw && Array.isArray((raw as { items: unknown }).items)) {
        items = (raw as { items: { fullName?: string; htmlUrl?: string; description?: string }[] })
          .items;
      } else if ('results' in raw && Array.isArray(raw.results)) {
        // Added handling for results field which is what the type actually has
        items = raw.results;
      } else {
        logger.warn({ raw }, 'Unexpected GitHub search response shape');
        items = [];
      }
      return items.map((r) => ({
        title: r.fullName ?? r.name ?? '',
        url: r.htmlUrl ?? r.url ?? '',
        snippet: r.description ?? '',
        sourceType: 'github',
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
      const videos = await withRetry(() => youtubeSearch(sq.text, apiKey, 'relevance', 10), {
        signal: this.abortSignal,
      });

      const candidates: SourceCandidate[] = [];

      // Try fetching transcripts for top videos to enrich snippet
      // Expand from 5 to 10 videos for deeper content coverage
      const topVideos = videos.slice(0, 10);
      const transcriptSettled = await Promise.allSettled(
        topVideos.map(async (v) => {
          try {
            const transcriptResult = await withRetry(() => getYouTubeTranscript(v.videoId, 'en'), {
              signal: this.abortSignal,
            });
            const transcriptText = transcriptResult.fullText || '';
            const snippet = transcriptText
              ? `Video: ${v.title}\n\nTranscript excerpt:\n${transcriptText.slice(0, 3000)}`
              : v.description;
            return {
              title: v.title,
              url: v.url,
              snippet,
              sourceType: 'youtube' as const,
              estimatedQuality: transcriptText ? 0.6 : 0.4,
              estimatedRelevance: 0.6,
              freshness: v.publishedAt
                ? `${String(Math.floor((Date.now() - new Date(v.publishedAt).getTime()) / 86400000))} days ago`
                : '',
              reasonForInclusion: `YouTube video with transcript: ${v.title}`,
              subQuestionId: sq.id,
            };
          } catch {
            return {
              title: v.title,
              url: v.url,
              snippet: v.description,
              sourceType: 'youtube' as const,
              estimatedQuality: 0.4,
              estimatedRelevance: 0.5,
              freshness: v.publishedAt
                ? `${String(Math.floor((Date.now() - new Date(v.publishedAt).getTime()) / 86400000))} days ago`
                : '',
              reasonForInclusion: `YouTube video: ${v.title}`,
              subQuestionId: sq.id,
            };
          }
        }),
      );

      for (const result of transcriptSettled) {
        if (result.status === 'fulfilled') {
          candidates.push(result.value);
        }
      }

      // Include remaining videos without transcript
      for (const v of videos.slice(10)) {
        candidates.push({
          title: v.title,
          url: v.url,
          snippet: v.description,
          sourceType: 'youtube',
          estimatedQuality: 0.4,
          estimatedRelevance: 0.5,
          freshness: v.publishedAt
            ? `${String(Math.floor((Date.now() - new Date(v.publishedAt).getTime()) / 86400000))} days ago`
            : '',
          reasonForInclusion: `YouTube video: ${v.title}`,
          subQuestionId: sq.id,
        });
      }

      return candidates;
    } catch (err) {
      logger.warn({ err, subQuestion: sq.id }, 'YouTube search failed');
      return [];
    }
  }

  private async searchStackOverflow(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];

    try {
      const raw = await withRetry(
        () => stackoverflowSearch(sq.text, '', 'relevance', '', false, 10),
        { signal: this.abortSignal },
      );
      const results: { title?: string; url?: string; body?: string }[] = raw;
      return results.map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.body ?? r.title ?? '',
        sourceType: 'stackoverflow',
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

  private async searchWikipedia(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];
    try {
      const { searchWikipedia } = await import('../tools/wikipediaSearch.js');
      const results = await withRetry(() => searchWikipedia(sq.text), { signal: this.abortSignal });
      return results.map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        sourceType: 'wikipedia',
        estimatedQuality: 0.7,
        estimatedRelevance: 0.8,
        freshness: '',
        reasonForInclusion: `Wikipedia reference for: ${sq.text}`,
        subQuestionId: sq.id,
      }));
    } catch (err) {
      logger.warn({ err, subQuestion: sq.id }, 'Wikipedia search failed');
      return [];
    }
  }

  private async searchPubMed(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];
    try {
      const { searchPubMed } = await import('../tools/pubmedSearch.js');
      const results = await withRetry(() => searchPubMed(sq.text, 5), { signal: this.abortSignal });
      return results.map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        sourceType: 'pubmed',
        estimatedQuality: 0.9,
        estimatedRelevance: 0.7,
        freshness: r.publishedDate ?? '',
        reasonForInclusion: `PubMed medical literature for: ${sq.text}`,
        subQuestionId: sq.id,
      }));
    } catch (err) {
      logger.warn({ err, subQuestion: sq.id }, 'PubMed search failed');
      return [];
    }
  }

  /**
   * Search Wayback Machine CDX archive for content related to the sub-question.
   * Uses keyword-based CDX API to find archived pages matching the query,
   * then adds them as sources with archive.org URLs.
   */
  private async searchWayback(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];

    try {
      // Build a CDX search URL with keyword query
      const keywords = sq.text
        .replace(/[?.:!]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 5)
        .join(' ');
      if (!keywords) return [];

      const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=*&output=json&limit=10&sort=reverse&matchType=prefix&filter=statuscode:200&q=${encodeURIComponent(keywords)}`;
      const cdxResp = await withRetry(
        () => fetch(cdxUrl, { signal: AbortSignal.timeout(10_000) }),
        { signal: this.abortSignal },
      );

      if (!cdxResp.ok) {
        logger.debug({ status: cdxResp.status }, 'Wayback CDX search failed');
        return [];
      }

      const cdxData = (await cdxResp.json()) as unknown;
      if (!Array.isArray(cdxData) || cdxData.length < 2) {
        return [];
      }

      // CDX returns [[header], [row1], [row2], ...]
      const rows = cdxData.slice(1) as string[][];
      const urlIdx = Array.isArray(cdxData[0]) ? (cdxData[0] as string[]).indexOf('original') : -1;
      const tsIdx = Array.isArray(cdxData[0]) ? (cdxData[0] as string[]).indexOf('timestamp') : -1;

      if (urlIdx === -1 || tsIdx === -1) return [];

      const candidates: SourceCandidate[] = [];
      for (const row of rows) {
        const originalUrl = row[urlIdx];
        const timestamp = row[tsIdx];
        if (!originalUrl || !timestamp) continue;

        const archiveUrl = `https://web.archive.org/web/${timestamp}/${originalUrl}`;
        candidates.push({
          title: `Archived: ${originalUrl.replace(/^https?:\/\//, '').slice(0, 80)}`,
          url: archiveUrl,
          snippet: `Archived at ${timestamp} from ${originalUrl}`,
          sourceType: 'web',
          estimatedQuality: 0.55,
          estimatedRelevance: 0.5,
          freshness: timestamp
            ? `${String(
                Math.floor(
                  (Date.now() -
                    new Date(
                      `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`,
                    ).getTime()) /
                    86400000,
                ),
              )} days ago`
            : '',
          reasonForInclusion: `Wayback Machine archive matching: ${sq.text}`,
          subQuestionId: sq.id,
        });
      }

      return candidates;
    } catch (err) {
      logger.warn({ err, subQuestion: sq.id }, 'Wayback search failed');
      return [];
    }
  }

  /**
   * For academic articles found in other backends, proactively fetch
   * their archived copies from Wayback Machine or Google Cache.
   * Returns additional candidates with the archived URLs.
   */
  private async recoverAcademicArchives(
    sq: SubQuestion,
    existingCandidates: SourceCandidate[],
  ): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];

    // Only process academic or paywalled-looking URLs
    const academicCandidates = existingCandidates.filter(
      (c) =>
        c.sourceType === 'academic' ||
        c.url.includes('doi.org') ||
        c.url.includes('ieee.org') ||
        c.url.includes('acm.org') ||
        c.url.includes('springer.com') ||
        c.url.includes('elsevier.com') ||
        c.url.includes('taylorandfrancis.com') ||
        c.url.includes('sagepub.com') ||
        c.url.includes('wiley.com'),
    );

    if (academicCandidates.length === 0) return [];

    const archiveCandidates: SourceCandidate[] = [];
    const topAcademic = academicCandidates.slice(0, 5);

    const settled = await Promise.allSettled(
      topAcademic.map(async (ac) => {
        try {
          const result = await withRetry(() => attemptExternalRecovery(ac.url), {
            signal: this.abortSignal,
          });
          if (result.content !== null && result.source !== null) {
            // Found an archived copy — add it as an additional source with a note
            const archiveUrl =
              result.source === 'wayback'
                ? `https://web.archive.org/web/2024/${ac.url}`
                : `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(ac.url)}`;
            return {
              title: `${ac.title} (${result.source === 'wayback' ? 'Wayback' : 'Google Cache'})`,
              url: archiveUrl,
              snippet: `Archived version of: ${ac.url}`,
              sourceType: 'academic' as const,
              estimatedQuality: 0.6,
              estimatedRelevance: 0.55,
              freshness: '',
              reasonForInclusion: `Archived copy of academic article via ${result.source}`,
              subQuestionId: sq.id,
            };
          }
          return null;
        } catch {
          return null;
        }
      }),
    );

    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) {
        archiveCandidates.push(result.value);
      }
    }

    return archiveCandidates;
  }

  // ── Scoring ────────────────────────────────────────────────────────────

  private scoreCandidates(candidates: SourceCandidate[]): ScoredCandidate[] {
    // Count URL frequencies for boost
    const urlCounts = new Map<string, number>();
    for (const c of candidates) {
      const normalized = normalizeUrlForDedup(c.url);
      urlCounts.set(normalized, (urlCounts.get(normalized) ?? 0) + 1);
    }

    return candidates.map((c) => {
      const subQuestion = this.state.getSubQuestions().find((sq) => sq.id === c.subQuestionId);
      const focusText = `${this.state.getState().query} ${subQuestion?.text ?? ''}`;
      const relevance = scoreTextRelevance(
        focusText,
        `${c.title} ${c.snippet} ${c.reasonForInclusion}`,
      );
      const driftPenalty = relevance.score < 0.45 ? 0.25 : relevance.admissible ? 1 : 0.65;
      const adjustedRelevance = Math.min(c.estimatedRelevance, relevance.score) * driftPenalty;
      const baseScore =
        this.weights.relevance * adjustedRelevance +
        this.weights.diversity * c.estimatedQuality +
        this.weights.freshness * estimateFreshness(c.freshness);

      // Frequency boost: duplicates indicate corroboration
      const count = urlCounts.get(normalizeUrlForDedup(c.url)) ?? 1;
      const freqBoost = count > 1 ? 1 + (count - 1) * 0.1 : 1;

      // Authority boost
      const domain = extractDomain(c.url);
      const authorityBoost = AUTHORITY_DOMAINS.has(domain) ? 1.15 : 1;

      // Path depth penalty
      let pathDepth = 0;
      try {
        pathDepth = new URL(c.url).pathname.split('/').filter(Boolean).length;
      } catch {
        /* ignore */
      }
      const depthPenalty = Math.pow(0.95, pathDepth);

      // Attach scoring metadata
      const scored = c as unknown as ScoredCandidate;
      scored.estimatedRelevance = adjustedRelevance;
      if (!relevance.admissible) {
        scored.reasonForInclusion = `${scored.reasonForInclusion} Relevance gate: ${relevance.reason}`;
      }
      scored.freqBoost = freqBoost;
      scored.authorityBoost = authorityBoost;
      scored.diversityScore = depthPenalty;
      // Override estimatedQuality with boosted score
      const boostedQuality = Math.min(1, baseScore * freqBoost * authorityBoost * depthPenalty * 2);
      scored.estimatedQuality = boostedQuality;
      scored.totalScore = boostedQuality;

      // SourceRanking: compute dual scores for sort/trust decisions
      const rankEntry = this.toMinimalSourceEntry(c);
      const scores = rankSource(rankEntry, count);
      scored.readPriorityScore = scores.readPriorityScore;
      scored.evidenceWeight = scores.evidenceWeight;

      return scored;
    });
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

  private rankCandidates(candidates: SourceCandidate[]): SourceCandidate[] {
    const sorted = [...candidates].sort((a, b) => {
      const sa = a as ScoredCandidate;
      const sb = b as ScoredCandidate;
      const scoreA = sa.readPriorityScore;
      const scoreB = sb.readPriorityScore;
      return scoreB - scoreA;
    });

    // Hostname diversity: limit per domain
    const hostnameCounts = new Map<string, number>();
    const result: SourceCandidate[] = [];
    for (const c of sorted) {
      const domain = extractDomain(c.url);
      const count = hostnameCounts.get(domain) ?? 0;
      if (count < maxPerHostname(domain)) {
        hostnameCounts.set(domain, count + 1);
        result.push(c);
      }
    }

    return result.slice(0, this.config.maxCandidatesPerSubQuestion);
  }
  // ── Convert candidate → source entry ───────────────────────────────────

  // ── Adapter: SourceCandidate → minimal SourceEntry for rankSource ──────────

  private toMinimalSourceEntry(candidate: SourceCandidate): SourceEntry {
    const sourceType = inferSourceTypeFromUrl(candidate.url, candidate.sourceType);
    const domain = extractDomain(candidate.url);
    const authorityClass = classifySourceAuthority({
      url: candidate.url,
      domain,
      sourceType,
    });
    return {
      id: '',
      title: candidate.title,
      url: candidate.url,
      accessDate: new Date().toISOString(),
      sourceType,
      domain,
      authorityClass,
      isPrimary:
        isPrimaryAuthority(authorityClass) || sourceType === 'academic' || sourceType === 'github',
      relevantSubQuestions: [candidate.subQuestionId],
      extractionStatus: 'pending' as const,
      subQuestionId: candidate.subQuestionId,
    };
  }

  private candidateToSourceEntry(candidate: SourceCandidate): SourceEntry {
    const urlSuffix = candidate.url.length > 40 ? candidate.url.slice(-40) : candidate.url;
    const rawId = `src-${urlSuffix}-${String(Date.now())}-${String(this.sourceEntryCounter++)}`;
    const subQuestion = this.state
      .getSubQuestions()
      .find((sq) => sq.id === candidate.subQuestionId);
    const focusText = `${this.state.getState().query} ${subQuestion?.text ?? ''}`;
    const relevance = scoreTextRelevance(
      focusText,
      `${candidate.title} ${candidate.snippet} ${candidate.reasonForInclusion} ${candidate.url}`,
    );
    const lowRelevance = !relevance.admissible && relevance.score < 0.35;
    const sourceType = inferSourceTypeFromUrl(candidate.url, candidate.sourceType);
    const domain = extractDomain(candidate.url);
    const authorityClass = classifySourceAuthority({ url: candidate.url, domain, sourceType });

    return {
      id: rawId.replace(/[^a-zA-Z0-9_-]/g, '_'),
      title: candidate.title,
      url: candidate.url,
      sourceType,
      domain,
      authorityClass,
      isPrimary:
        isPrimaryAuthority(authorityClass) || sourceType === 'academic' || sourceType === 'github',
      relevantSubQuestions: [candidate.subQuestionId],
      extractionStatus: lowRelevance ? 'failed' : ('pending' as const),
      accessDate: new Date().toISOString(),
      subQuestionId: candidate.subQuestionId,
      usageStatus: lowRelevance ? 'discarded' : 'selected',
      ...(lowRelevance
        ? { discardReason: 'low_relevance' as const, limitations: relevance.reason }
        : {}),
      relevanceScore: relevance.score,
    };
  }

  // ── Free academic/discovery backends ────────────────────────────────────

  private async searchOpenAlex(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];
    try {
      const results = await withRetry(() => searchOpenAlex(sq.text, 10), {
        signal: this.abortSignal,
      });
      return results.map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        sourceType: 'openalex',
        estimatedQuality: 0.8,
        estimatedRelevance: 0.6,
        freshness: r.publishedDate ?? '',
        reasonForInclusion: `OpenAlex scholarly work for: ${sq.text}`,
        subQuestionId: sq.id,
      }));
    } catch (err) {
      logger.warn({ err, subQuestion: sq.id }, 'OpenAlex search failed');
      return [];
    }
  }

  private async searchCrossref(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];
    try {
      const results = await withRetry(() => searchCrossref(sq.text, 10), {
        signal: this.abortSignal,
      });
      return results.map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        sourceType: 'crossref',
        estimatedQuality: 0.85,
        estimatedRelevance: 0.6,
        freshness: r.publishedDate ?? '',
        reasonForInclusion: `Crossref DOI metadata for: ${sq.text}`,
        subQuestionId: sq.id,
      }));
    } catch (err) {
      logger.warn({ err, subQuestion: sq.id }, 'Crossref search failed');
      return [];
    }
  }

  private async searchDataCite(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];
    try {
      const results = await withRetry(() => searchDataCite(sq.text, 10), {
        signal: this.abortSignal,
      });
      return results.map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        sourceType: 'datacite',
        estimatedQuality: 0.75,
        estimatedRelevance: 0.5,
        freshness: r.publishedDate ?? '',
        reasonForInclusion: `DataCite research dataset for: ${sq.text}`,
        subQuestionId: sq.id,
      }));
    } catch (err) {
      logger.warn({ err, subQuestion: sq.id }, 'DataCite search failed');
      return [];
    }
  }

  private async searchRor(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];
    try {
      const results = await withRetry(() => searchRor(sq.text, 10), {
        signal: this.abortSignal,
      });
      return results.map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        sourceType: 'ror',
        estimatedQuality: 0.8,
        estimatedRelevance: 0.55,
        freshness: r.established
          ? `${String(new Date().getFullYear() - r.established)} years ago`
          : '',
        reasonForInclusion: `ROR organization record for: ${sq.text}`,
        subQuestionId: sq.id,
      }));
    } catch (err) {
      logger.warn({ err, subQuestion: sq.id }, 'ROR search failed');
      return [];
    }
  }

  private async searchSemanticScholar(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];
    try {
      const results = await withRetry(() => searchSemanticScholar(sq.text, 10), {
        signal: this.abortSignal,
      });
      return results.map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        sourceType: 'semantic_scholar',
        estimatedQuality: 0.85,
        estimatedRelevance: 0.65,
        freshness: r.publishedDate ?? '',
        reasonForInclusion: `Semantic Scholar paper for: ${sq.text}`,
        subQuestionId: sq.id,
      }));
    } catch (err) {
      logger.warn({ err, subQuestion: sq.id }, 'Semantic Scholar search failed');
      return [];
    }
  }

  private async searchGdelt(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];
    try {
      const results = await withRetry(() => searchGdelt(sq.text, '30d', 10), {
        signal: this.abortSignal,
      });
      return results.map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        sourceType: 'gdelt',
        estimatedQuality: 0.65,
        estimatedRelevance: 0.5,
        freshness: r.publishedDate ?? '',
        reasonForInclusion: `GDELT news/event coverage for: ${sq.text}`,
        subQuestionId: sq.id,
      }));
    } catch (err) {
      logger.warn({ err, subQuestion: sq.id }, 'GDELT search failed');
      return [];
    }
  }

  private async searchWikidata(sq: SubQuestion): Promise<SourceCandidate[]> {
    if (!this.budget.recordToolCall()) return [];
    try {
      const results = await withRetry(() => searchWikidata(sq.text, 'en', 10), {
        signal: this.abortSignal,
      });
      return results.map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
        sourceType: 'wikidata',
        estimatedQuality: 0.8,
        estimatedRelevance: 0.7,
        freshness: '',
        reasonForInclusion: `Wikidata knowledge graph entity for: ${sq.text}`,
        subQuestionId: sq.id,
      }));
    } catch (err) {
      logger.warn({ err, subQuestion: sq.id }, 'Wikidata search failed');
      return [];
    }
  }
}

// ── Internal types ─────────────────────────────────────────────────────────
