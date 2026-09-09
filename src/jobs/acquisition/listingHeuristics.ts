/**
 * Pure listing-URL classification heuristics (zero network, string ops only).
 *
 * Aggregate pages (search/collections/articles) are discovery artifacts, not
 * postings. 'unknown' is kept — heuristics never silently exclude; they only
 * justify an explicit, warned withhold at the seam.
 */
export type ListingUrlClass = 'posting' | 'aggregate' | 'unknown';

const TITLE_AGGREGATE_PREFIX = /^(how to|why |what is|guide to|become an? )\b/i;

const AGGREGATE_PATH_PATTERNS: RegExp[] = [
  /\/jobs\/search(?:\/|$)/i,
  /\/jobs\/collections(?:\/|$)/i,
  /\/blog(?:\/|$)/i,
  /\/articles?(?:\/|$)/i,
  /\/news(?:\/|$)/i,
  /\/career-advice(?:\/|$)/i,
  /\/resources(?:\/|$)/i,
  /\/guide(?:\/|$)/i,
];

function splitUrl(url: string): {
  host: string;
  path: string;
  query: URLSearchParams;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { host: '', path: url.toLowerCase(), query: new URLSearchParams() };
  }
  return {
    host: parsed.hostname.toLowerCase(),
    path: parsed.pathname.toLowerCase(),
    query: parsed.searchParams,
  };
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/**
 * Classify a URL as a job 'posting', an 'aggregate' discovery page, or
 * 'unknown'. `titleHint` can downgrade unknown URLs with editorial titles to
 * aggregate, but never overrides a high-confidence posting URL.
 */
export function classifyListingUrl(url: string, titleHint?: string): ListingUrlClass {
  if (typeof url !== 'string' || url.trim().length === 0) return 'unknown';
  const { host, path, query } = splitUrl(url.trim());
  const segs = segments(path);

  // --- high-confidence posting paths ---
  // LinkedIn: /jobs/view/<id>
  if (segs[0] === 'jobs' && segs[1] === 'view' && segs[2] !== undefined) return 'posting';
  // Generic /job/<id> (id carries a digit) and SEEK /job/<digits>
  const jobSeg = segs[1];
  if (segs[0] === 'job' && jobSeg !== undefined && /\d/.test(jobSeg)) return 'posting';
  // Indeed: /viewjob or explicit requisition key jk=
  if (segs[0] === 'viewjob' || query.has('jk')) return 'posting';
  // Glassdoor: /job-listing/<slug>
  if (segs[0] === 'job-listing' && segs[1] !== undefined) return 'posting';
  // Greenhouse: /jobs/<org>/jobs/<id>; Lever: /<org>/job/<id>; Ashby: /posting/<id>
  if (segs.length >= 4 && segs[0] === 'jobs' && segs[2] === 'jobs') return 'posting';
  if (segs.length >= 3 && segs[1] === 'job' && segs[2] !== undefined) return 'posting';
  if (segs[0] === 'posting' && segs[1] !== undefined) return 'posting';
  // Known ATS hosts: Greenhouse/Workday end with job id; Lever with hex id;
  // Ashby carries a /posting/<id> segment.
  const lastSeg = segs[segs.length - 1];
  if (
    (host.includes('greenhouse.io') || host.includes('workday')) &&
    lastSeg !== undefined &&
    /\d/.test(lastSeg)
  ) {
    return 'posting';
  }
  if (host.includes('lever.co') && segs.length >= 2 && /^[0-9a-f]{6,}$/i.test(lastSeg ?? '')) {
    return 'posting';
  }
  if (host.includes('ashbyhq.com') && segs.includes('posting')) return 'posting';

  // --- high-confidence aggregate paths ---
  // Bare /jobs collection (SEEK et al) — never /job/<id>, handled above.
  if (segs[0] === 'jobs' && segs.length === 1) return 'aggregate';
  if (segs[0] === 'jobs' && (segs[1] === 'search' || segs[1] === 'collections')) {
    return 'aggregate';
  }
  // /jobs/<numeric-id> is a posting shape on several boards; /jobs/<other> is
  // left unknown (kept) rather than guessed.
  const jobsSecond = segs[1];
  if (
    segs[0] === 'jobs' &&
    segs.length === 2 &&
    jobsSecond !== undefined &&
    /\d/.test(jobsSecond)
  ) {
    return 'posting';
  }
  for (const pattern of AGGREGATE_PATH_PATTERNS) {
    if (pattern.test(path)) return 'aggregate';
  }
  if (path.includes('/companies/') || path.includes('/company/')) {
    if (!/\/job(\/|$)/.test(path)) return 'aggregate';
  }

  // Title-only aggregate signal (URL itself was not a posting).
  if (titleHint !== undefined && TITLE_AGGREGATE_PREFIX.test(titleHint.trim())) {
    return 'aggregate';
  }
  return 'unknown';
}
