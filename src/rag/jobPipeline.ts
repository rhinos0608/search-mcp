import { searchJobSpy, jobSpyHealth, type JobSpyAcquisitionParams, type FlatJobRecord } from '../utils/jobspyClient.js';
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
import { extractJobListingsFromHtml,
  extractJobLinksFromHtml,
  documentsFromJobListings,
} from './adapters/job.js';
import crypto from 'node:crypto';
import { dedupJobListings } from './jobDedup.js';
import { rankJobListings, type JobScore } from './jobRanking.js';
import { fetchJobDetails } from 'jobspy-js';
import { embedTexts, embedTextsBatched } from './embedding.js';
import { prepareCorpus, retrieveCorpus } from './pipeline.js';
import {
  applySemanticByteBudget,
} from '../semanticLimits.js';
import type { JobListingMvp, JobSearchConstraints, JobSource } from './types/job.js';
import type { GraphJobPosting, GraphCompany, GraphLocation } from './types/jobGraph.js';

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
    logger.info({ tool: 'job_pipeline', stage: 'discovery', query: params.query }, 'Starting discovery');

    const searchJobSpyFn = this.deps.searchJobSpy ?? searchJobSpy;
    const webSearchFn = this.deps.webSearch ?? webSearch;
    const webCrawlFn = this.deps.webCrawl ?? webCrawl;

    try {
      const jobspyRecords = await searchJobSpyFn(params);
      if (jobspyRecords.length > 0) {
        logger.info({ tool: 'job_pipeline', stage: 'discovery', count: jobspyRecords.length, source: 'jobspy' }, 'Acquired jobs from JobSpy');
        return jobspyRecords.map(f => this.mapFlatToRaw(f));
      }
    } catch (err) {
      logger.error({ tool: 'job_pipeline', stage: 'discovery', source: 'jobspy', err }, 'JobSpy discovery failed, falling back');
    }

    logger.info({ tool: 'job_pipeline', stage: 'discovery', source: 'jobspy', count: 0 }, 'JobSpy returned no results, falling back to web search');

    const searchResults = await webSearchFn(params.query, 10);
    if (searchResults.length === 0) {
      return [];
    }

    // Light crawl of search results to find job links
    const cfg = loadConfig();
    const firstUrl = searchResults[0]?.url;
    if (!firstUrl) return [];

    const crawlResult = await webCrawlFn(firstUrl, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken ?? '', {
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
    logger.info({ tool: 'job_pipeline', stage: 'discovery', count: uniqueLinks.length, source: 'web_fallback' }, 'Found job links via web fallback');

    return uniqueLinks.map(url => ({
      site: 'other',
      title: 'Unknown Title',
      jobUrl: url,
    }));
  }

  /**
   * Stage 2: Normalization
   */
  normalize(records: RawJobRecord[], _query: string): PipelineJobRecord[] {
    logger.info({ tool: 'job_pipeline', stage: 'normalization', inputCount: records.length, query: _query }, 'Starting normalization');

    const mvpListings = records.map(r => this.mapPipelineToMvp(this.mapMvpToPipeline(this.mapRawToMvp(r))));
    const dedupedMvp = dedupJobListings(mvpListings);

    const pipelineRecords = dedupedMvp.map(mvp => {
      const raw = records.find(r => r.jobUrl === mvp.sourceUrl);
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
      const clusters = new Map<string, { jobIds: string[]; sites: Set<string>; company: string; title: string }>();
      for (const record of pipelineRecords) {
        if (record.company) {
          const key = crypto
            .createHash('sha256')
            .update(`${record.company.trim().toLowerCase()}|${record.title.trim().toLowerCase()}`)
            .digest('hex');
          const existing = clusters.get(key) ?? { jobIds: [], sites: new Set<string>(), company: record.company, title: record.title };
          if (record.id) existing.jobIds.push(record.id);
          existing.sites.add(record.site);
          clusters.set(key, existing);
        }
      }

      for (const [clusterId, info] of clusters) {
        if (info.jobIds.length > 1) {
          const canonicalId = info.jobIds[0];
          if (canonicalId) {
            insertDuplicateCluster({
              clusterId,
              canonicalJobId: canonicalId,
              memberJobIds: info.jobIds,
              memberSites: [...info.sites],
              clusterSize: info.jobIds.length,
              firstSeenAt: Date.now(),
              lastSeenAt: Date.now(),
            }, db);
          }
        }
      }
    }

    logger.info({ tool: 'job_pipeline', stage: 'normalization', outputCount: pipelineRecords.length }, 'Normalized and indexed records');
    return pipelineRecords;
  }

  /**
   * Stage 3: Scoring (Lexical Pass)
   */
  scoreMetadata(records: PipelineJobRecord[], constraints: JobSearchConstraints): ScoredRecord[] {
    logger.info({ tool: 'job_pipeline', stage: 'scoring_lexical', count: records.length }, 'Starting lexical scoring');

    const mvpListings = records.map(r => this.mapPipelineToMvp(r));
    const scoredMvp = rankJobListings(mvpListings, '', constraints);

    return scoredMvp.map(s => {
      const record = records.find(r => r.jobUrl === s.listing.sourceUrl);
      if (!record) return null;
      return {
        ...record,
        score: s.overallScore,
      };
    })
    .filter((r): r is ScoredRecord => r !== null)
    .sort((a, b) => b.score - a.score);
  }

  /**
   * Stage 4: Enrichment
   */
  async enrich(records: ScoredRecord[]): Promise<EnrichedRecord[]> {
    const topRecords = records.slice(0, 50);
    logger.info({ tool: 'job_pipeline', stage: 'enrichment', count: topRecords.length }, 'Starting enrichment crawl');

    const cfg = loadConfig();
    const enriched: EnrichedRecord[] = [];
    const webCrawlFn = this.deps.webCrawl ?? webCrawl;

    // Simple sequential crawl for now to avoid overloading
    for (const record of topRecords) {
      let enrichedDescription: string | undefined;

      // Try lightweight fetchJobDetails first (no full page load)
      try {
        if (record.jobUrl && record.id) {
          const fetchDetails = fetchJobDetails as (
            site: string,
            id: string,
            options: { format: string }
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
        enriched.push(updated);
        continue;
      }

      // Fallback: full Crawl4AI page load
      try {
        const crawlResult = await webCrawlFn(record.jobUrl, cfg.crawl4ai.baseUrl, cfg.crawl4ai.apiToken ?? '', {
          strategy: 'bfs',
          maxDepth: 1,
          maxPages: 1,
          includeExternalLinks: false,
        });

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

              if (best.title !== 'Untitled Job Listing') updated.title = best.title;
              if (best.company) updated.company = best.company;
              if (best.location) updated.location = best.location;
              if (best.workMode !== 'unknown') updated.workMode = best.workMode;
              
              this.upsertGraphEntities(updated);
              enriched.push(updated);
              continue;
            }
          }
        }
        enriched.push(record);
      } catch (err) {
        logger.warn({ tool: 'job_pipeline', url: record.jobUrl, err }, 'Enrichment crawl failed for record');
        enriched.push(record);
      }
    }

    return enriched;
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
    }
  ): Promise<JobScore[]> {
    logger.info({ tool: 'job_pipeline', stage: 'embedding_rank', count: records.length }, 'Starting embedding and reranking');

    const mvpListings = records.map(r => {
      const mvp = this.mapPipelineToMvp(r);
      if (r.enrichedExtractedText) {
        mvp.extractedText = r.enrichedExtractedText;
      }
      return mvp;
    });

    if (!opts.baseUrl || opts.dimensions === undefined) {
      return rankJobListings(mvpListings, query);
    }

    const documents = documentsFromJobListings(mvpListings);
    const budgeted = applySemanticByteBudget(documents, opts.maxBytes ?? 1024 * 1024);

    if (budgeted.items.length === 0) {
      return rankJobListings(mvpListings, query);
    }

    const docTexts = budgeted.items.map(d => d.text);
    const docTitles = budgeted.items.map(d => d.title ?? d.id);

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
      return rankJobListings(mvpListings, query);
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

    const ranked = rankJobListings(mvpListings, query, undefined, semanticScores);

    // Update graph with final rank/verification status
    for (const score of ranked) {
      const record = records.find(r => r.jobUrl === score.listing.sourceUrl);
      if (record) {
        try {
          insertJobPosting({
            ...this.mapPipelineToGraph(record),
            verificationStatus: 'verified',
            confidence: score.overallScore,
          });
        } catch (err) {
          logger.warn({ tool: 'job_pipeline', jobUrl: record.jobUrl, err }, 'Failed to insert final ranked job into graph');
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
      title: f.title,
      jobUrl: f.job_url,
    };
    if (f.id !== undefined) r.id = f.id;
    if (f.company !== undefined) r.company = f.company;
    if (f.location !== undefined) r.location = f.location;
    if (f.description !== undefined) r.description = f.description;
    if (f.min_amount !== undefined) r.salaryMin = f.min_amount;
    if (f.max_amount !== undefined) r.salaryMax = f.max_amount;
    if (f.currency !== undefined) r.salaryCurrency = f.currency;
    if (f.interval !== undefined) r.salaryInterval = f.interval;
    if (f.is_remote !== undefined) r.isRemote = f.is_remote;
    if (f.job_type !== undefined) r.jobType = f.job_type;
    if (f.date_posted !== undefined) r.datePosted = f.date_posted;
    return r;
  }

  private mapRawToMvp(r: RawJobRecord): JobListingMvp {
    const mvp: JobListingMvp = {
      title: r.title,
      workMode: r.isRemote ? 'remote' : 'unknown',
      source: (r.site as JobSource | undefined) ?? 'other',
      extractedText: r.description ?? '',
      confidence: { title: 1, location: 0.5, workMode: 0.5, salary: 0.5, overall: 0.5 },
      verificationStatus: 'aggregator_result',
      caveats: [],
    };
    if (r.company !== undefined) mvp.company = r.company;
    if (r.location !== undefined) mvp.location = r.location;
    if (r.salaryMin !== undefined && r.salaryMax !== undefined) {
      mvp.salaryRaw = `${String(r.salaryMin)} - ${String(r.salaryMax)} ${r.salaryCurrency ?? ''}`;
    }
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
    if (mvp.company !== undefined) p.company = mvp.company;
    if (mvp.location !== undefined) p.location = mvp.location;
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
    const mvp: JobListingMvp = {
      title: p.title,
      workMode: p.workMode,
      source: (p.site as JobSource | undefined) ?? 'other',
      extractedText: p.description ?? '',
      confidence: { title: 1, location: 0.5, workMode: 0.5, salary: 0.5, overall: p.confidence },
      verificationStatus: 'aggregator_result',
      caveats: p.caveats,
    };
    if (p.company !== undefined) mvp.company = p.company;
    if (p.location !== undefined) mvp.location = p.location;
    if (p.salaryMin !== undefined && p.salaryMax !== undefined) {
      mvp.salaryRaw = `${String(p.salaryMin)} - ${String(p.salaryMax)} ${p.salaryCurrency ?? ''}`;
    }
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
    if (p.company !== undefined) g.companyId = p.company.trim().toLowerCase();
    if (p.location !== undefined) g.locationId = p.location.trim().toLowerCase().replace(/\s+/g, '-');
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
