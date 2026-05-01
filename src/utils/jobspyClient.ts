/**
 * JobSpy Bridge Client — thin TypeScript wrapper around `jobspy-js`.
 *
 * Wraps the npm package's `scrapeJobs()` function with:
 *   - Typed params mapping our tool interface → jobspy-js params
 *   - Error handling via the project's logger
 *   - Health check (connectivity probe)
 *
 * The `FlatJobRecord` type is defined inline because jobspy-js does not
 * re-export it from its main package entry — it lives in dist/scraper.d.ts.
 *
 * ESM-only. All internal imports use `.js` extension.
 */

import { scrapeJobs } from 'jobspy-js';
import { logger } from '../logger.js';

// ── FlatJobRecord ──────────────────────────────────────────────────────────

/**
 * Unified flat job record returned by jobspy-js scrapeJobs().
 *
 * Source: jobspy-js/dist/scraper.d.ts
 */
export interface FlatJobRecord {
  id?: string;
  site: string;
  job_url: string;
  job_url_direct?: string;
  title: string;
  company?: string;
  location?: string;
  date_posted?: string;
  job_type?: string;
  salary_source?: string;
  interval?: string;
  min_amount?: number;
  max_amount?: number;
  currency?: string;
  is_remote?: boolean;
  job_level?: string;
  job_function?: string;
  listing_type?: string;
  emails?: string;
  description?: string;
  company_industry?: string;
  company_url?: string;
  company_logo?: string;
  company_url_direct?: string;
  company_addresses?: string;
  company_num_employees?: string;
  company_revenue?: string;
  company_description?: string;
  skills?: string;
  experience_range?: string;
  company_rating?: number;
  company_reviews_count?: number;
  vacancy_count?: number;
  work_from_home_type?: string;
}

// ── Input shape (our tool-level interface) ────────────────────────────────

export interface JobSpyAcquisitionParams {
  /** Job boards to search: 'linkedin', 'indeed', 'zip_recruiter', 'glassdoor', etc. */
  sites?: string[];
  /** Free-text search term (title, skills, keywords). */
  query: string;
  /** Location string, e.g. "San Francisco, CA". */
  location?: string;
  /** Filter to remote-only listings. */
  isRemote?: boolean;
  /** Employment type: "fulltime", "parttime", "contract". */
  jobType?: string;
  /** Maximum number of results per site. Defaults to 20. */
  resultsWanted?: number;
  /** Country name or domain code, e.g. "usa", "australia". */
  country?: string;
  /** Only return jobs posted within this many hours. */
  hoursOld?: number;
  /** Convert all salary values to annual amounts. */
  enforceAnnualSalary?: boolean;
  /** Proxy servers in "user:pass@host:port" or "host:port" format. */
  proxies?: string | string[];
}

// ── Internal helper ───────────────────────────────────────────────────────

/** Map our typed params to the jobspy-js ScrapeJobsParams shape. */
function toJobspyParams(p: JobSpyAcquisitionParams): Record<string, unknown> {
  return {
    site_name: p.sites,
    search_term: p.query,
    location: p.location ?? '',
    is_remote: p.isRemote ?? false,
    results_wanted: p.resultsWanted ?? 20,
    ...(p.jobType !== undefined ? { job_type: p.jobType } : {}),
    ...(p.country !== undefined ? { country_indeed: p.country } : {}),
    ...(p.proxies !== undefined ? { proxies: p.proxies } : {}),
    ...(p.hoursOld !== undefined ? { hours_old: p.hoursOld } : {}),
    ...(p.enforceAnnualSalary !== undefined ? { enforce_annual_salary: p.enforceAnnualSalary } : {}),
    // Request markdown descriptions — our chunking pipeline expects it
    description_format: 'markdown',
  };
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Search job boards via JobSpy and return structured job records.
 *
 * All sites are scraped in parallel. A failure from one site does NOT
 * block results from others. Errors are logged but never thrown — an
 * empty array is returned when no records could be acquired, so callers
 * can proceed with fallback mechanisms (web search, etc.).
 */
export async function searchJobSpy(
  params: JobSpyAcquisitionParams,
): Promise<FlatJobRecord[]> {
  const opts = toJobspyParams(params);

  logger.info(
    {
      tool: 'jobspy',
      sites: opts.site_name,
      search_term: opts.search_term,
      location: opts.location,
      results_wanted: opts.results_wanted,
    },
    'JobSpy: starting acquisition',
  );

  try {
    const result = await scrapeJobs(opts as Parameters<typeof scrapeJobs>[0]);
    const records = (result as { jobs: FlatJobRecord[] }).jobs ?? [];

    logger.info(
      { tool: 'jobspy', sites: opts.site_name, recordsReturned: records.length },
      'JobSpy: acquisition complete',
    );

    return records;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { tool: 'jobspy', search_term: opts.search_term, err: message },
      'JobSpy: acquisition failed',
    );
    return [];
  }
}

/**
 * Connectivity health check for JobSpy.
 *
 * Issues a minimal scrape with `results_wanted: 0`. If the call completes
 * without throwing, JobSpy is considered healthy. Never throws — returns
 * false on any failure.
 */
export async function jobSpyHealth(): Promise<boolean> {
  try {
    const result = await scrapeJobs({
      search_term: '__health_probe__',
      results_wanted: 0,
      site_name: ['linkedin'],
    });
    const ok = result !== undefined;
    const recordsReturned = (result as { jobs: FlatJobRecord[] })?.jobs?.length ?? 0;

    logger.debug(
      { tool: 'jobspy', healthCheck: 'ok', recordsReturned },
      'JobSpy: health check passed',
    );
    return ok;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { tool: 'jobspy', healthCheck: 'failed', err: message },
      'JobSpy: health check failed',
    );
    return false;
  }
}
