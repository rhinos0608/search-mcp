import {
  searchJobSpy,
  jobSpyHealth,
  type JobSpyAcquisitionParams,
  type FlatJobRecord,
} from '../utils/jobspyClient.js';
import {
  getJobGraphDb,
  insertJobPosting,
  insertCompany,
  insertLocation,
  insertDuplicateCluster,
  graphHealth,
} from '../utils/jobGraphDb.js';
import { logger } from '../logger.js';
import { webSearch } from '../tools/webSearch.js';
import { webCrawl } from '../tools/webCrawl.js';
import { loadConfig } from '../config.js';
import {
  extractJobListingsFromHtml,
  extractJobLinksFromHtml,
  documentsFromJobListings,
  calculateJobConfidence,
} from './adapters/job.js';
import crypto from 'node:crypto';
import { dedupJobListings } from './jobDedup.js';
import { rankJobListings, applyHardFilters, type JobScore } from './jobRanking.js';
import { fetchJobDetails } from 'jobspy-js';
import { embedTexts, embedTextsBatched } from './embedding.js';
import { prepareCorpus, retrieveCorpus } from './pipeline.js';
import { applySemanticByteBudget } from '../semanticLimits.js';
import { QualityGate } from './quality/qualityGate.js';
import type { JobListingMvp, JobSearchConstraints, JobSource, WorkMode } from './types/job.js';
import type { GraphJobPosting, GraphCompany, GraphLocation } from './types/jobGraph.js';

// ── Bot-challenge / anti-scraping page detection ─────────────────────────────

/**
 * Patterns that indicate a page is a bot-challenge, CAPTCHA, or anti-scraping
 * interstitial rather than a real job listing. Matches against title and description.
 */
const BOT_CHALLENGE_PATTERNS: RegExp[] = [
  /help\s+us\s+protect/i,
  /verify\s+you\s+are\s+(?:a\s+)?human/i,
  /unusual\s+traffic/i,
  /access\s+(?:denied|blocked)/i,
  /captcha/i,
  /are\s+you\s+a\s+robot/i,
  /please\s+verify/i,
  /security\s+check/i,
  /blocked\s+(?:because|due)/i,
  /too\s+many\s+requests/i,
  /rate\s+limit/i,
  /cloudflare/i,
  /incapsula/i,
  /perimeterx/i,
  /datadome/i,
  /akamai/i,
  /distil\s+networks/i,
];

/**
 * Check if a text string matches known bot-challenge / anti-scraping patterns.
 * Used to filter challenge pages from job listings.
 */
export function isBotChallengeText(text: string): boolean {
  return BOT_CHALLENGE_PATTERNS.some((p) => p.test(text));
}

/**
 * Detect whether a job record is likely a bot-challenge or anti-scraping page
 * rather than a real job listing. Checks the title and description for known
 * bot-challenge patterns.
 */
export function isBotChallengeRecord(record: RawJobRecord): boolean {
  const text = [record.title, record.description]
    .filter((s): s is string => s !== undefined)
    .join(' ');
  if (isBotChallengeText(text)) return true;

  // Short title combined with missing/empty description is suspicious from known adversarial sources
  if (
    record.site === 'glassdoor' &&
    record.title.length < 15 &&
    (!record.description || record.description.trim() === '')
  ) {
    return true;
  }

  return false;
}

export interface RawJobRecord {
  id?: string;
  site: string;
  title: string;
  company?: string;
  location?: string;
  jobUrl: string;
  description?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  salaryInterval?: string;
  isRemote?: boolean;
  jobType?: string;
  datePosted?: string;
}

export interface PipelineJobRecord extends RawJobRecord {
  companyId?: string;
  locationId?: string;
  workMode: 'remote' | 'hybrid' | 'onsite' | 'unknown';
  confidence: number;
  caveats: string[];
}

export interface ScoredRecord extends PipelineJobRecord {
  score: number;
  matchedConstraints: string[];
}

export interface EnrichedRecord extends ScoredRecord {
  enrichedExtractedText?: string;
}

export interface JobPipelineDeps {
  searchJobSpy?: typeof searchJobSpy;
  webSearch?: typeof webSearch;
  webCrawl?: typeof webCrawl;
  getJobGraphDb?: typeof getJobGraphDb;
  graphHealth?: typeof graphHealth;
  jobSpyHealth?: typeof jobSpyHealth;
}

/**
 * Concurrency config for enrichment crawl (per-record fetch).
 * Higher = faster but more load on job boards.
 */
const ENRICH_CONCURRENCY = 10;

/**
 * Maximum number of records to enrich.
 */
const MAX_ENRICH_RECORDS = 50;

/**
 * Format salary fields into a human-readable string.
 * Handles cases where only min, only max, or both are present.
 * Includes the interval (hour, day, year, etc.) when available.
 */
function formatSalary(
  min: number | undefined,
  max: number | undefined,
  currency: string | undefined,
  interval: string | undefined,
): string | undefined {
  const unit = interval ? `/${interval}` : '';
  const cur = currency ?? '';

  if (min !== undefined && max !== undefined) {
    return `${String(min)} - ${String(max)} ${cur}${unit}`.trim();
  }
  if (min !== undefined) {
    return `From ${String(min)} ${cur}${unit}`.trim();
  }
  if (max !== undefined) {
    return `Up to ${String(max)} ${cur}${unit}`.trim();
  }
  return undefined;
}

export class JobPipeline {
  private deps: JobPipelineDeps;

  constructor(deps?: JobPipelineDeps) {
    this.deps = deps ?? {};
  }

  /**
   * Stage 1: Discovery
   * Primary: call searchJobSpy()
   * Fallback: webSearch() + extract links
   */
  async discover(params: JobSpyAcquisitionParams): Promise<RawJobRecord[]> {
    logger.info(
      { tool: 'job_pipeline', stage: 'discovery', query: params.query },
      'Starting discovery',
    );

    const searchJobSpyFn = this.deps.searchJobSpy ?? searchJobSpy;
    const webSearchFn = this.deps.webSearch ?? webSearch;
    const webCrawlFn = this.deps.webCrawl ?? webCrawl;

    try {
      const jobspyRecords = await searchJobSpyFn(params);
      if (jobspyRecords.length > 0) {
        logger.info(
          {
            tool: 'job_pipeline',
            stage: 'discovery',
            count: jobspyRecords.length,
            source: 'jobspy',
          },
          'Acquired jobs from JobSpy',
        );
        return jobspyRecords.map((f) => this.mapFlatToRaw(f));
      }
    } catch (err) {
      logger.error(
        { tool: 'job_pipeline', stage: 'discovery', source: 'jobspy', err },
        'JobSpy discovery failed, falling back',
      );
    }

    logger.info(
      { tool: 'job_pipeline', stage: 'discovery', source: 'jobspy', count: 0 },
      'JobSpy returned no results, falling back to web search',
    );

    const searchResults = await webSearchFn(params.query, 10);
    if (searchResults.length === 0) {
      return [];
    }

    // Light crawl of search results to find job links
    const cfg = loadConfig();
    const firstUrl = searchResults[0]?.url;
    if (!firstUrl) return [];

    const crawlResult = await webCrawlFn(firstUrl, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken, {
      strategy: 'bfs',
      maxDepth: 1,
      maxPages: 10,
      includeExternalLinks: true,
    });

    const jobLinks: string[] = [];
    for (const page of crawlResult.pages) {
      if (page.html) {
        jobLinks.push(...extractJobLinksFromHtml(page.html, page.url));
      }
    }

    const uniqueLinks = [...new Set(jobLinks)];
    logger.info(
      {
        tool: 'job_pipeline',
        stage: 'discovery',
        count: uniqueLinks.length,
        source: 'web_fallback',
      },
      'Found job links via web fallback',
    );

    return uniqueLinks.map((url) => ({
      site: 'other',
      title: 'Unknown Title',
      jobUrl: url,
    }));
  }

  /**
   * Stage 2: Normalization
   */
  normalize(records: RawJobRecord[], _query: string): PipelineJobRecord[] {
    logger.info(
      { tool: 'job_pipeline', stage: 'normalization', inputCount: records.length, query: _query },
      'Starting normalization',
    );

    // Filter bot-challenge / anti-scraping pages before any processing
    const cleanRecords = records.filter((r) => !isBotChallengeRecord(r));
    if (cleanRecords.length < records.length) {
      logger.info(
        {
          tool: 'job_pipeline',
          stage: 'normalization',
          filtered: records.length - cleanRecords.length,
        },
        'Filtered bot-challenge / anti-scraping pages',
      );
    }

    // Map directly Raw → Mvp. The old code chained Raw→Mvp→Pipeline→Mvp which
    // dropped structured salary fields because mapMvpToPipeline was called
    // without the original RawJobRecord (raw was undefined).
    const mvpListings = cleanRecords.map((r) => this.mapRawToMvp(r));
    const dedupedMvp = dedupJobListings(mvpListings);

    // Quality gate: filter out non-job pages, wrong country, IT admin, etc.
    const qualityGate = new QualityGate();
    const qualityResult = qualityGate.filter(dedupedMvp);
    if (qualityResult.rejected.length > 0) {
      logger.info(
        {
          tool: 'job_pipeline',
          stage: 'normalization',
          passed: qualityResult.passed.length,
          rejected: qualityResult.rejected.length,
          byPageIntent: qualityResult.stats.rejectedByPageIntent,
          byCountry: qualityResult.stats.rejectedByCountry,
          byOccupation: qualityResult.stats.rejectedByOccupation,
          byBoilerplate: qualityResult.stats.rejectedByBoilerplate,
          byEntryLevel: qualityResult.stats.rejectedByEntryLevel,
        },
        'Quality gate filtered listings',
      );
    }

    const pipelineRecords = qualityResult.passed.map((mvp) => {
      const raw = records.find((r) => r.jobUrl === mvp.sourceUrl);
      return this.mapMvpToPipeline(mvp, raw);
    });

    // Upsert to Graph DB
    const getDb = this.deps.getJobGraphDb ?? getJobGraphDb;
    const db = getDb();
    if (db) {
      for (const record of pipelineRecords) {
        this.upsertGraphEntities(record);
      }

      // Build duplicate clusters from records sharing company+title across sites
      const clusters = new Map<
        string,
        { jobIds: string[]; sites: Set<string>; company: string; title: string }
      >();
      for (const record of pipelineRecords) {
        if (record.company) {
          const key = crypto
            .createHash('sha256')
            .update(`${record.company.trim().toLowerCase()}|${record.title.trim().toLowerCase()}`)
            .digest('hex');
          const existing = clusters.get(key) ?? {
            jobIds: [],
            sites: new Set<string>(),
            company: record.company,
            title: record.title,
          };
          if (record.id) existing.jobIds.push(record.id);
          existing.sites.add(record.site);
          clusters.set(key, existing);
        }
      }

      for (const [clusterId, info] of clusters) {
        if (info.jobIds.length > 1) {
          const canonicalId = info.jobIds[0];
          if (canonicalId) {
            insertDuplicateCluster(
              {
                clusterId,
                canonicalJobId: canonicalId,
                memberJobIds: info.jobIds,
                memberSites: [...info.sites],
                clusterSize: info.jobIds.length,
                firstSeenAt: Date.now(),
                lastSeenAt: Date.now(),
              },
              db,
            );
          }
        }
      }
    }

    logger.info(
      { tool: 'job_pipeline', stage: 'normalization', outputCount: pipelineRecords.length },
      'Normalized and indexed records',
    );
    return pipelineRecords;
  }

  /**
   * Stage 3: Scoring (Lexical Pass)
   */
  scoreMetadata(records: PipelineJobRecord[], constraints: JobSearchConstraints): ScoredRecord[] {
    logger.info(
      { tool: 'job_pipeline', stage: 'scoring_lexical', count: records.length },
      'Starting lexical scoring',
    );

    const mvpListings = records.map((r) => this.mapPipelineToMvp(r));
    const scoredMvp = rankJobListings(mvpListings, '', constraints);

    return scoredMvp
      .map((s) => {
        const record = records.find((r) => r.jobUrl === s.listing.sourceUrl);
        if (!record) return null;
        return {
          ...record,
          score: s.overallScore,
          matchedConstraints: s.matchedConstraints,
        };
      })
      .filter((r): r is ScoredRecord => r !== null)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Stage 4: Enrichment (PARALLEL)
   */
  async enrich(records: ScoredRecord[]): Promise<EnrichedRecord[]> {
    const topRecords = records.slice(0, MAX_ENRICH_RECORDS);
    logger.info(
      {
        tool: 'job_pipeline',
        stage: 'enrichment',
        count: topRecords.length,
        concurrency: ENRICH_CONCURRENCY,
      },
      'Starting enrichment crawl (parallel)',
    );

    const cfg = loadConfig();
    const webCrawlFn = this.deps.webCrawl ?? webCrawl;

    // Parallel crawl with concurrency limit
    const results = await this.concurrencyLimitedMap(
      topRecords,
      ENRICH_CONCURRENCY,
      async (record) => {
        let enrichedDescription: string | undefined;

        // Try lightweight fetchJobDetails first (no full page load)
        try {
          if (record.jobUrl && record.id) {
            const fetchDetails = fetchJobDetails as (
              site: string,
              id: string,
              options: { format: string },
            ) => Promise<{ description?: string }>;
            const detailResult = await fetchDetails(record.site, record.id, { format: 'markdown' });
            if (detailResult.description) {
              enrichedDescription = detailResult.description;
            }
          }
        } catch {
          // fetchJobDetails failed silently — fall through to crawl
        }

        if (enrichedDescription) {
          const updated: EnrichedRecord = {
            ...record,
            enrichedExtractedText: enrichedDescription,
            description: enrichedDescription,
          };
          this.upsertGraphEntities(updated);
          return updated;
        }

        // Fallback: full Crawl4AI page load (parallel to other records)
        try {
          const crawlResult = await webCrawlFn(
            record.jobUrl,
            cfg.crawl4ai.baseUrl,
            cfg.crawl4ai.apiToken,
            {
              strategy: 'bfs',
              maxDepth: 1,
              maxPages: 1,
              includeExternalLinks: false,
              pageTimeout: 15000,
            },
          );

          const page = crawlResult.pages[0];
          if (page?.success && page.html) {
            const listings = extractJobListingsFromHtml(page.html, record.jobUrl);
            if (listings.length > 0) {
              const best = listings[0];
              if (best) {
                const updated: EnrichedRecord = {
                  ...record,
                  enrichedExtractedText: best.extractedText,
                };
                const newDesc = best.extractedText || record.description;
                if (newDesc !== undefined) updated.description = newDesc;

                if (best.title !== 'Untitled Job Listing' && !isBotChallengeText(best.title))
                  updated.title = best.title;
                if (best.company) updated.company = best.company;
                if (best.location) updated.location = best.location;
                if (best.workMode !== 'unknown') updated.workMode = best.workMode;

                this.upsertGraphEntities(updated);
                return updated;
              }
            }
          }
          return record;
        } catch (err) {
          logger.warn(
            { tool: 'job_pipeline', url: record.jobUrl, err },
            'Enrichment crawl failed for record',
          );
          return record;
        }
      },
    );

    logger.info(
      { tool: 'job_pipeline', stage: 'enrichment', enrichedCount: String(results.length) },
      'Enrichment complete',
    );
    return results;
  }

  /**
   * Concurrency-limited map: process items in batches, at most `concurrency` at a time.
   */
  private async concurrencyLimitedMap<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
      for (;;) {
        const index = nextIndex;
        if (index >= items.length) break;
        nextIndex = index + 1;
        try {
          results[index] = await fn(items[index] as T);
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          logger.warn({ err: reason, index }, 'concurrencyLimitedMap: item failed');
        }
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.allSettled(workers);
    return results.filter((r): r is R => r !== undefined);
  }

  /**
   * Stage 5: Embedding & Reranking
   */
  async embedAndRank(
    records: EnrichedRecord[],
    query: string,
    opts: {
      baseUrl?: string;
      apiToken?: string;
      dimensions?: number;
      topK?: number;
      maxBytes?: number;
    },
    constraints?: JobSearchConstraints,
    enforceConstraints = false,
  ): Promise<JobScore[]> {
    logger.info(
      { tool: 'job_pipeline', stage: 'embedding_rank', count: records.length },
      'Starting embedding and reranking',
    );

    let mvpListings = records.map((r) => {
      const mvp = this.mapPipelineToMvp(r);
      if (r.enrichedExtractedText) {
        mvp.extractedText = r.enrichedExtractedText;
      }
      return mvp;
    });

    // Final defense: remove any listings with bot-challenge titles
    // (can be reintroduced by enrichment re-crawling adversarial job boards)
    const botBeforeCount = mvpListings.length;
    mvpListings = mvpListings.filter((mvp) => !isBotChallengeText(mvp.title));
    if (mvpListings.length < botBeforeCount) {
      logger.info(
        {
          tool: 'job_pipeline',
          stage: 'bot_filter',
          before: botBeforeCount,
          after: mvpListings.length,
        },
        'Filtered bot-challenge listings after enrichment',
      );
    }

    // Apply hard filtering if enforceConstraints is true
    if (enforceConstraints && constraints) {
      const beforeCount = mvpListings.length;
      mvpListings = applyHardFilters(mvpListings, constraints);
      const filteredCount = beforeCount - mvpListings.length;
      logger.info(
        {
          tool: 'job_pipeline',
          stage: 'hard_filter',
          before: beforeCount,
          after: mvpListings.length,
          filtered: filteredCount,
        },
        'Applied hard constraints',
      );
    }

    if (!opts.baseUrl || opts.dimensions === undefined) {
      return rankJobListings(mvpListings, query, constraints);
    }

    const documents = documentsFromJobListings(mvpListings);
    const budgeted = applySemanticByteBudget(documents, opts.maxBytes ?? 1024 * 1024);

    if (budgeted.items.length === 0) {
      return rankJobListings(mvpListings, query);
    }

    const docTexts = budgeted.items.map((d) => d.text);
    const docTitles = budgeted.items.map((d) => d.title ?? d.id);

    const [docEmbed, queryEmbed] = await Promise.all([
      embedTextsBatched({
        baseUrl: opts.baseUrl,
        apiToken: opts.apiToken,
        texts: docTexts,
        mode: 'document',
        dimensions: opts.dimensions,
        titles: docTitles,
      }),
      embedTexts({
        baseUrl: opts.baseUrl,
        apiToken: opts.apiToken,
        texts: [query],
        mode: 'query',
        dimensions: opts.dimensions,
      }),
    ]);

    const queryEmbedding = queryEmbed.embeddings[0];
    if (!queryEmbedding) {
      return rankJobListings(mvpListings, query, constraints);
    }

    const corpus = prepareCorpus({
      adapter: 'job',
      documents: budgeted.items,
      embeddings: docEmbed.embeddings,
      model: docEmbed.model,
      dimensions: docEmbed.dimensions,
    });

    const response = retrieveCorpus(corpus, {
      query,
      queryEmbedding,
      topK: opts.topK ?? 10,
    });

    const semanticScores = new Map<string, number>();
    for (const res of response.results) {
      const docId = res.item.metadata?.documentId as string | undefined;
      semanticScores.set(docId ?? res.item.url, res.score.fused);
    }

    const ranked = rankJobListings(mvpListings, query, constraints, semanticScores);

    // Update graph with final rank/verification status
    for (const score of ranked) {
      const record = records.find((r) => r.jobUrl === score.listing.sourceUrl);
      if (record) {
        try {
          insertJobPosting({
            ...this.mapPipelineToGraph(record),
            verificationStatus: 'verified',
            confidence: score.overallScore,
          });
        } catch (err) {
          logger.warn(
            { tool: 'job_pipeline', jobUrl: record.jobUrl, err },
            'Failed to insert final ranked job into graph',
          );
        }
      }
    }

    return ranked;
  }

  async verifyHealth(): Promise<boolean> {
    const jobSpyHealthFn = this.deps.jobSpyHealth ?? jobSpyHealth;
    const graphHealthFn = this.deps.graphHealth ?? graphHealth;
    const jobspyOk = await jobSpyHealthFn();
    const graphOk = graphHealthFn();
    return jobspyOk && graphOk;
  }

  private mapFlatToRaw(f: FlatJobRecord): RawJobRecord {
    const r: RawJobRecord = {
      site: f.site,
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      title: f.title ?? '',
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      jobUrl: f.job_url ?? '',
    };
    if (f.id != null) r.id = f.id;
    if (f.company != null) r.company = f.company;
    if (f.location != null) r.location = f.location;
    if (f.description != null) r.description = f.description;
    if (f.min_amount != null) r.salaryMin = f.min_amount;
    if (f.max_amount != null) r.salaryMax = f.max_amount;
    if (f.currency != null) r.salaryCurrency = f.currency;
    if (f.interval != null) r.salaryInterval = f.interval;
    if (f.is_remote != null) r.isRemote = f.is_remote;
    if (f.job_type != null) r.jobType = f.job_type;
    if (f.date_posted != null) r.datePosted = f.date_posted;
    return r;
  }

  private mapRawToMvp(r: RawJobRecord): JobListingMvp {
    const workMode: WorkMode = r.isRemote ? 'remote' : 'unknown';
    const salaryRaw = formatSalary(r.salaryMin, r.salaryMax, r.salaryCurrency, r.salaryInterval);
    const confidence = calculateJobConfidence({
      title: r.title,
      location: r.location,
      workMode,
      salaryRaw,
    });
    const mvp: JobListingMvp = {
      title: r.title,
      workMode,
      source: (r.site as JobSource | undefined) ?? 'other',
      extractedText: r.description ?? '',
      confidence,
      verificationStatus: 'aggregator_result',
      caveats: [],
    };
    if (r.company != null) mvp.company = r.company;
    if (r.location != null) mvp.location = r.location;
    if (salaryRaw) mvp.salaryRaw = salaryRaw;
    mvp.sourceUrl = r.jobUrl;
    if (r.id !== undefined) mvp.jobId = r.id;
    if (r.datePosted !== undefined) mvp.postedRaw = r.datePosted;
    return mvp;
  }

  private mapMvpToPipeline(mvp: JobListingMvp, raw?: RawJobRecord): PipelineJobRecord {
    const p: PipelineJobRecord = {
      site: raw?.site ?? 'other',
      title: mvp.title,
      jobUrl: mvp.sourceUrl ?? '',
      workMode: mvp.workMode,
      confidence: mvp.confidence.overall,
      caveats: mvp.caveats,
    };
    if (raw?.id !== undefined) p.id = raw.id;
    if (mvp.company != null) p.company = mvp.company;
    if (mvp.location != null) p.location = mvp.location;
    p.description = mvp.extractedText;
    if (raw?.salaryMin !== undefined) p.salaryMin = raw.salaryMin;
    if (raw?.salaryMax !== undefined) p.salaryMax = raw.salaryMax;
    if (raw?.salaryCurrency !== undefined) p.salaryCurrency = raw.salaryCurrency;
    if (raw?.salaryInterval !== undefined) p.salaryInterval = raw.salaryInterval;
    if (mvp.workMode === 'remote') p.isRemote = true;
    if (raw?.jobType !== undefined) p.jobType = raw.jobType;
    if (raw?.datePosted !== undefined) p.datePosted = raw.datePosted;
    return p;
  }

  private mapPipelineToMvp(p: PipelineJobRecord): JobListingMvp {
    const salaryRaw = formatSalary(p.salaryMin, p.salaryMax, p.salaryCurrency, p.salaryInterval);
    const confidence = calculateJobConfidence({
      title: p.title,
      location: p.location,
      workMode: p.workMode,
      salaryRaw,
    });
    const mvp: JobListingMvp = {
      title: p.title,
      workMode: p.workMode,
      source: (p.site as JobSource | undefined) ?? 'other',
      extractedText: p.description ?? '',
      confidence,
      verificationStatus: 'aggregator_result',
      caveats: p.caveats,
    };
    if (p.company != null) mvp.company = p.company;
    if (p.location != null) mvp.location = p.location;
    if (salaryRaw) mvp.salaryRaw = salaryRaw;
    mvp.sourceUrl = p.jobUrl;
    if (p.id !== undefined) mvp.jobId = p.id;
    if (p.datePosted !== undefined) mvp.postedRaw = p.datePosted;
    return mvp;
  }

  private mapPipelineToGraph(p: PipelineJobRecord): GraphJobPosting {
    const g: GraphJobPosting = {
      jobId: p.id ?? `ext-${Buffer.from(p.jobUrl).toString('base64').slice(0, 16)}`,
      title: p.title,
      sourceSite: p.site,
      sourceUrl: p.jobUrl,
      verificationStatus: 'pending',
      confidence: p.confidence,
      caveats: p.caveats,
    };
    if (p.company != null) g.companyId = p.company.trim().toLowerCase();
    if (p.location != null) g.locationId = p.location.trim().toLowerCase().replace(/\s+/g, '-');
    if (p.salaryMin !== undefined) g.salaryMin = p.salaryMin;
    if (p.salaryMax !== undefined) g.salaryMax = p.salaryMax;
    if (p.salaryCurrency !== undefined) g.salaryCurrency = p.salaryCurrency;
    if (p.salaryInterval !== undefined) g.salaryInterval = p.salaryInterval;
    if (p.workMode === 'remote' || p.workMode === 'hybrid' || p.workMode === 'onsite') {
      g.workMode = p.workMode;
    }
    if (p.jobType !== undefined) g.jobType = p.jobType;
    if (p.datePosted !== undefined) g.postedAt = p.datePosted;
    if (p.description !== undefined) {
      g.description = p.description;
      g.extractedText = p.description;
    }
    return g;
  }

  private upsertGraphEntities(record: PipelineJobRecord) {
    const now = Date.now();

    if (record.company) {
      const company: GraphCompany = {
        companyId: record.company.trim().toLowerCase(),
        name: record.company,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      insertCompany(company);
    }

    if (record.location) {
      const location: GraphLocation = {
        locationId: record.location.trim().toLowerCase().replace(/\s+/g, '-'),
        displayName: record.location,
      };
      insertLocation(location);
    }

    insertJobPosting(this.mapPipelineToGraph(record));
  }
}
