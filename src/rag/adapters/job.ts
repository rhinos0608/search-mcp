import * as cheerio from 'cheerio';
import type { Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';

type CheerioEl = Cheerio<AnyNode>;

import type { RawDocument, RagChunk } from '../types.js';
import type {
  JobFieldConfidence,
  JobListingMvp,
  JobSource,
  VerificationStatus,
  WorkMode,
} from '../types/job.js';
import { detectJobSource } from '../sources/jobSources.js';

interface JobPostingJsonLd {
  title?: string | undefined;
  datePosted?: string | undefined;
  identifier?: unknown;
  hiringOrganization?: unknown;
  jobLocation?: unknown;
}

const CAVEAT_PATTERNS: { caveat: string; pattern: RegExp }[] = [
  { caveat: 'contract', pattern: /\bcontract\b/i },
  { caveat: 'temp', pattern: /\btemp(?:orary)?\b/i },
  { caveat: 'casual', pattern: /\bcasual\b/i },
  { caveat: 'agency', pattern: /\bvia agency\b/i },
  { caveat: 'agency', pattern: /\brecruitment agency\b/i },
  { caveat: 'closing_soon', pattern: /\bclosing soon\b/i },
  { caveat: 'closing_soon', pattern: /\bapplications close\b/i },
];

const SALARY_PATTERNS: RegExp[] = [
  /\$\d+(?:,\d{3})*(?:\.\d+)?\s*[–-]\s*\$?\d+(?:,\d{3})*(?:\.\d+)?\s*\/\s*hr/i,
  /\$\d+(?:,\d{3})*(?:\.\d+)?\s*[–-]\s*\$?\d+(?:,\d{3})*(?:\.\d+)?\s*a\s*year/i,
  /\$\d{1,3}(?:\.\d+)?k\s*[–-]\s*\$?\d{1,3}(?:\.\d+)?k/i,
  /\$\d{1,3}(?:\.\d+)?k\s*\+\s*super/i,
];

export function extractJobListingsFromHtml(html: string, url: string): JobListingMvp[] {
  const source = detectJobSource(url);
  const jsonLdListings = extractJobPostingsFromJsonLd(html);

  if (jsonLdListings.length > 0) {
    return jsonLdListings
      .map((jobPosting) => buildListing(html, url, source, jobPosting))
      .filter((listing): listing is JobListingMvp => listing !== undefined);
  }

  // Try multi-listing extraction for search results / collection pages
  const multiListings = extractMultiListingsFromHtml(html, url);
  if (multiListings.length > 0) {
    return multiListings;
  }

  // Fall back to single-listing extraction
  const listing = buildListing(html, url, source);
  if (listing) return [listing];

  // Content-preserving fallback: when no structured extraction works, wrap the
  // full page text as a single listing. The embedding/retrieval layer can still
  // surface relevant content from unstructured pages, and this prevents silently
  // dropping data from unknown job boards.
  const pageText = extractTextContent(html);
  if (pageText && pageText.trim().length > 0) {
    const title = extractTitle(html) ?? tryExtractMeaningfulTitle(pageText);
    const company = extractCompany(html);
    const location = extractLocation(html);
    const salaryRaw = extractSalaryRaw(html);
    const workMode = extractWorkMode(html);
    const jobId = extractJobId(url, html);
    const confidence = calculateJobConfidence({ title, location, workMode, salaryRaw });

    const fallback: JobListingMvp = {
      title: title ?? 'Untitled Job Listing',
      workMode,
      source,
      extractedText: pageText,
      confidence,
      verificationStatus: determineVerificationStatus(source, html),
      caveats: extractCaveats(html),
    };
    if (company) fallback.company = company;
    if (location) fallback.location = location;
    if (salaryRaw) fallback.salaryRaw = salaryRaw;
    if (url) fallback.sourceUrl = url;
    if (jobId) fallback.jobId = jobId;

    return [fallback];
  }

  return [];
}

export function extractTitle(html: string): string | undefined {
  const jobPosting = extractFirstJobPostingFromJsonLd(html);
  const jsonTitle = normalizeText(jobPosting?.title);
  if (jsonTitle) {
    return jsonTitle;
  }

  const $ = loadHtml(html);
  const heading = normalizeText($('h1').first().text());
  if (heading) {
    return heading;
  }

  const documentTitle = normalizeText($('title').first().text());
  return stripSiteSuffix(documentTitle);
}

export function extractCompany(html: string): string | undefined {
  const jobPosting = extractFirstJobPostingFromJsonLd(html);
  const hiringOrganization = readObjectProperty(jobPosting?.hiringOrganization);
  const jsonCompany = normalizeText(readStringProperty(hiringOrganization?.name));
  if (jsonCompany) {
    return jsonCompany;
  }

  const $ = loadHtml(html);
  const selectors = ['.company', '[data-company]', '.hiringOrganization', '.companyName'];
  for (const selector of selectors) {
    const text = normalizeText($(selector).first().text());
    if (text) {
      return text;
    }
  }

  return undefined;
}

export function extractLocation(html: string): string | undefined {
  const jobPosting = extractFirstJobPostingFromJsonLd(html);
  const jsonLocation = readLocationFromJsonLd(jobPosting?.jobLocation);
  if (jsonLocation) {
    return jsonLocation;
  }

  const $ = loadHtml(html);
  const selectors = ['.location', '[data-location]', '.jobsearch-JobInfoHeader-item'];
  for (const selector of selectors) {
    const text = normalizeText($(selector).first().text());
    if (text) {
      return text;
    }
  }

  return undefined;
}

export function extractSalaryRaw(html: string): string | undefined {
  const text = extractTextContent(html);
  for (const pattern of SALARY_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[0]) {
      return normalizeText(match[0]);
    }
  }

  return undefined;
}

export function extractWorkMode(html: string): WorkMode {
  const text = extractTextContent(html).toLowerCase();
  if (/(?:\bhybrid\b)/i.test(text)) {
    return 'hybrid';
  }
  if (/(?:\bremote\b)/i.test(text)) {
    return 'remote';
  }
  if (/(?:\bonsite\b|\bon[- ]site\b|\bin[- ]office\b|\bin the office\b)/i.test(text)) {
    return 'onsite';
  }

  return 'unknown';
}

export function extractCaveats(html: string): string[] {
  const text = extractTextContent(html);
  const caveats: string[] = [];
  const seen = new Set<string>();

  for (const { caveat, pattern } of CAVEAT_PATTERNS) {
    if (pattern.test(text) && !seen.has(caveat)) {
      seen.add(caveat);
      caveats.push(caveat);
    }
  }

  return caveats;
}

export function extractPostedDate(html: string): string | undefined {
  const jobPosting = extractFirstJobPostingFromJsonLd(html);
  const jsonDatePosted = normalizeText(jobPosting?.datePosted);
  if (jsonDatePosted) {
    return jsonDatePosted;
  }

  const text = extractTextContent(html);
  const patterns = [
    /posted\s+\d+\s+days?\s+ago/i,
    /\d+\s+days?\s+ago/i,
    /posted\s+today/i,
    /posted\s+yesterday/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) {
      return normalizeText(match[0]);
    }
  }

  return undefined;
}

export function extractJobId(url: string, html: string): string | undefined {
  const urlJobId = extractJobIdFromUrl(url);
  if (urlJobId) {
    return urlJobId;
  }

  const $ = loadHtml(html);
  const dataJobId = normalizeText($('[data-job-id]').first().attr('data-job-id'));
  if (dataJobId) {
    return dataJobId;
  }

  const dataJk = normalizeText($('[data-jk]').first().attr('data-jk'));
  if (dataJk) {
    return dataJk;
  }

  const jobPosting = extractFirstJobPostingFromJsonLd(html);
  const identifier = extractIdentifier(jobPosting?.identifier);
  if (identifier) {
    return identifier;
  }

  const urlJk = extractQueryParam(url, 'jk');
  if (urlJk) {
    return urlJk;
  }

  return undefined;
}

export function calculateJobConfidence(fields: {
  title: string | undefined;
  location: string | undefined;
  workMode: WorkMode;
  salaryRaw: string | undefined;
}): JobFieldConfidence {
  const title = fields.title ? 0.95 : 0;
  const location = fields.location ? 0.8 : 0;
  const workMode = fields.workMode === 'unknown' ? 0 : 0.9;
  const salary = fields.salaryRaw ? 0.85 : 0;
  const overall = title * 0.4 + location * 0.25 + workMode * 0.2 + salary * 0.15;

  return {
    title,
    location,
    workMode,
    salary,
    overall,
  };
}

export function determineVerificationStatus(source: JobSource, html: string): VerificationStatus {
  const text = extractTextContent(html);
  if (source === 'jora' && /aggregator|copied from|republished/i.test(text)) {
    return 'aggregator_result';
  }

  if (text.length < 200) {
    return 'search_result_only';
  }

  const confidence = calculateJobConfidence({
    title: extractTitle(html),
    location: extractLocation(html),
    workMode: extractWorkMode(html),
    salaryRaw: extractSalaryRaw(html),
  });

  if (confidence.overall < 0.3) {
    return 'needs_manual_check';
  }

  return 'listing_page_fetched';
}

export function extractTextContent(html: string): string {
  const $ = loadHtml(html);
  $('script, style, noscript').remove();
  return normalizeText($.root().text()) ?? '';
}

export function documentsFromJobListings(listings: JobListingMvp[]): RawDocument[] {
  return listings.map((listing, index) => {
    const text = buildJobListingText(listing);
    const documentId = listing.jobId ?? listing.sourceUrl ?? `job-${String(index)}`;
    return {
      id: documentId,
      adapter: 'job',
      text,
      url: listing.sourceUrl ?? `job:${listing.source}:${documentId}`,
      title: listing.title,
      metadata: {
        source: listing.source,
        sourceUrl: listing.sourceUrl,
        jobId: listing.jobId,
        confidence: listing.confidence,
        verificationStatus: listing.verificationStatus,
        caveats: [...listing.caveats],
      },
    };
  });
}

export function chunksFromJobListings(listings: JobListingMvp[]): RagChunk[] {
  return listings.map((listing, index) => ({
    text: buildJobListingText(listing),
    url: listing.sourceUrl ?? `job:${listing.source}:${String(listing.jobId ?? index)}`,
    section: listing.company ? `${listing.company} > ${listing.title}` : listing.title,
    charOffset: 0,
    chunkIndex: index,
    totalChunks: listings.length,
    metadata: {
      ...listing,
    },
  }));
}

function buildJobListingText(listing: JobListingMvp): string {
  return [
    listing.title,
    listing.company,
    listing.location,
    listing.workMode,
    listing.salaryRaw,
    listing.extractedText,
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n');
}

function buildListing(
  html: string,
  url: string,
  source: JobSource,
  jobPosting?: JobPostingJsonLd,
): JobListingMvp | undefined {
  const title = normalizeText(jobPosting?.title) ?? extractTitle(html);
  if (!title) {
    return undefined;
  }

  const company =
    normalizeText(readStringProperty(readObjectProperty(jobPosting?.hiringOrganization)?.name)) ??
    extractCompany(html);
  const location = readLocationFromJsonLd(jobPosting?.jobLocation) ?? extractLocation(html);
  const salaryRaw = extractSalaryRaw(html);
  const workMode = extractWorkMode(html);
  const jobId = extractJobId(url, html) ?? extractIdentifier(jobPosting?.identifier);
  const postedRaw = normalizeText(jobPosting?.datePosted) ?? extractPostedDate(html);
  const confidence = calculateJobConfidence({ title, location, workMode, salaryRaw });
  const verificationStatus = determineVerificationStatus(source, html);

  const listing: JobListingMvp = {
    title,
    workMode,
    source,
    extractedText: extractTextContent(html),
    confidence,
    verificationStatus,
    caveats: extractCaveats(html),
  };

  if (company) {
    listing.company = company;
  }
  if (location) {
    listing.location = location;
  }
  if (salaryRaw) {
    listing.salaryRaw = salaryRaw;
  }
  if (jobId) {
    listing.jobId = jobId;
  }
  if (postedRaw) {
    listing.postedRaw = postedRaw;
  }
  if (url) {
    listing.sourceUrl = url;
  }

  return listing;
}

function extractJobPostingsFromJsonLd(html: string): JobPostingJsonLd[] {
  const values = extractJsonLdValues(html);
  const jobPostings: JobPostingJsonLd[] = [];

  for (const value of values) {
    collectJobPostings(value, jobPostings);
  }

  return jobPostings;
}

function extractFirstJobPostingFromJsonLd(html: string): JobPostingJsonLd | undefined {
  return extractJobPostingsFromJsonLd(html)[0];
}

function extractJsonLdValues(html: string): unknown[] {
  const $ = loadHtml(html);
  const values: unknown[] = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = normalizeText($(element).contents().text() || $(element).text());
    if (!raw) {
      return;
    }

    try {
      values.push(JSON.parse(raw));
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  });

  return values;
}

function collectJobPostings(value: unknown, jobPostings: JobPostingJsonLd[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJobPostings(item, jobPostings);
    }
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  const type = readStringProperty(value['@type']);
  if (type?.toLowerCase() === 'jobposting') {
    jobPostings.push(value as JobPostingJsonLd);
  }

  const graph = value['@graph'];
  if (Array.isArray(graph)) {
    for (const item of graph) {
      collectJobPostings(item, jobPostings);
    }
  }
}

function readLocationFromJsonLd(jobLocation: unknown): string | undefined {
  if (Array.isArray(jobLocation)) {
    for (const entry of jobLocation) {
      const value = readLocationFromJsonLd(entry);
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  if (!isPlainObject(jobLocation)) {
    return undefined;
  }

  const address = readObjectProperty(jobLocation.address);
  if (!address) {
    return undefined;
  }

  const locality = normalizeText(readStringProperty(address.addressLocality));
  const region = normalizeText(readStringProperty(address.addressRegion));
  const parts = [locality, region].filter((part): part is string => Boolean(part));
  if (parts.length > 0) {
    return parts.join(' ');
  }

  return normalizeText(readStringProperty(address.streetAddress));
}

function extractIdentifier(identifier: unknown): string | undefined {
  if (typeof identifier === 'string') {
    return normalizeText(identifier);
  }

  if (isPlainObject(identifier)) {
    const directValue = readStringProperty(identifier.value);
    if (directValue) {
      return normalizeText(directValue);
    }

    const schemaValue = readStringProperty(identifier['@value']);
    if (schemaValue) {
      return normalizeText(schemaValue);
    }
  }

  return undefined;
}

function readObjectProperty(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function readStringProperty(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function extractJobIdFromUrl(url: string): string | undefined {
  try {
    const parsedUrl = new URL(url);
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
    for (let index = 0; index < pathSegments.length; index += 1) {
      const segment = pathSegments[index];
      if (!segment) {
        continue;
      }

      const nextSegment = pathSegments[index + 1];

      if (segment.toLowerCase() === 'job' && nextSegment) {
        return decodeURIComponent(nextSegment);
      }

      if (segment.toLowerCase() === 'viewjob' && nextSegment) {
        return decodeURIComponent(nextSegment);
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function extractQueryParam(url: string, key: string): string | undefined {
  try {
    const parsedUrl = new URL(url);
    return normalizeText(parsedUrl.searchParams.get(key));
  } catch {
    return undefined;
  }
}

function stripSiteSuffix(value: string | undefined): string | undefined {
  const normalized = normalizeText(value);
  if (!normalized) {
    return undefined;
  }

  const separators = [' - ', ' | ', ' — ', ' – '];
  for (const separator of separators) {
    const index = normalized.lastIndexOf(separator);
    if (index > 0) {
      return normalized.slice(0, index).trim();
    }
  }

  return normalized;
}

// ── Multi-listing extraction for search results / collection pages ────────

/** CSS selectors that commonly contain job listing cards on search result pages. */
const LISTING_CARD_SELECTORS = [
  'article[class*=job]',
  'article[class*=position]',
  'article[class*=listing]',
  // 'article' is a broad catch-all used by many modern job boards.
  // extractListingFromCard performs keyword validation on these elements to reduce false positives.
  'article',
  'li[class*=job]',
  'li[class*=position]',
  'li[class*=result]',
  'div[class*=job-card]',
  'div[class*=job-result]',
  'div[class*=job-listing]',
  'div[class*=job-search]',
  'div[class*=search-result]',
  'div[class*=jobRow]',
  'div[data-jobid]',
  'div[data-job-id]',
  'div[itemtype*="JobPosting"]', // schema.org microdata
  'div[itemtype*="jobposting"]',
  'tr[class*=job]',
  'section[class*=job]',
  'section[class*=result]',
];

/** CSS selectors for title elements within a listing card. */
const TITLE_SELECTORS = [
  'h2 a',
  'h2',
  'h3 a',
  'h3',
  'h4 a',
  'h4',
  'a[class*=title]',
  'a[class*=job-title]',
  'a[data-jobtitle]',
  'span[class*=title]',
  'div[class*=title]',
  '[data-automation=jobTitle]',
  '[data-automation=job-title]',
  '[itemprop="title"]', // schema.org microdata
  '[itemprop="name"]',
];

/** CSS selectors for company name elements within a listing card. */
const COMPANY_SELECTORS = [
  'span[class*=company]',
  'div[class*=company]',
  'a[class*=company]',
  '[data-automation=jobCompany]',
  '[itemprop=hiringOrganization]',
  '[itemprop="hiringOrganization"] [itemprop="name"]',
  '.hiringOrganization',
];

/** CSS selectors for location elements within a listing card. */
const LOCATION_SELECTORS = [
  'span[class*=location]',
  'div[class*=location]',
  'li[class*=location]',
  '[data-automation=jobLocation]',
  '[itemprop=jobLocation]',
  '[itemprop="jobLocation"] [itemprop="addressLocality"]',
  '[itemprop="jobLocation"] [itemprop="addressRegion"]',
];

/** CSS selectors for salary elements within a listing card. */
const SALARY_SELECTORS = [
  'span[class*=salary]',
  'div[class*=salary]',
  '[data-automation=jobSalary]',
  '[itemprop=baseSalary]',
  '[itemprop="baseSalary"] [itemprop="value"]',
];

/** CSS selectors for anchor elements containing job links within a listing card. */
const LINK_SELECTORS = [
  'h2 a[href]',
  'h3 a[href]',
  'h4 a[href]',
  'a[class*=title][href]',
  'a[class*=job-title][href]',
  'a[data-automation*=job-title][href]',
  'a[href*=/job/]',
  'a[href*=/jobs/]',
  'a[href*=/viewjob]',
  'a[href*=/job-detail]',
  'a[href*=/job-openings]',
  'a[href*=/position/]',
  'a[href*=/positions/]',
  'a[href*=/career/]',
  'a[href*=/careers/]',
  'a[href*=/opening/]',
  'a[href*=/vacancy/]',
];

/**
 * Extract multiple job listings from search result / collection pages.
 * Uses heuristic HTML structure parsing rather than JSON-LD.
 */
export function extractMultiListingsFromHtml(html: string, baseUrl: string): JobListingMvp[] {
  const $ = loadHtml(html);
  const base = tryParseUrl(baseUrl);
  if (!base) return [];

  const listings: JobListingMvp[] = [];

  // Try to find listing card containers
  for (const selector of LISTING_CARD_SELECTORS) {
    const cards = $(selector);
    if (cards.length < 2) continue; // Need at least 2 to be a multi-listing page
    if (cards.length > 100) continue; // Suspicious — likely a false positive

    cards.each((_, card) => {
      const cardEl = $(card);
      const listing = extractListingFromCard(cardEl, base, baseUrl);
      if (listing) {
        listings.push(listing);
      }
    });

    if (listings.length >= 2) break; // Found valid multi-listings
  }

  return listings;
}

function extractListingFromCard(
  $card: CheerioEl,
  _base: URL,
  pageUrl: string,
): JobListingMvp | undefined {
  // Validate candidate cards by checking for job-related keywords in the card's text
  const cardText = $card.text().toLowerCase();
  const jobKeywords = ['job', 'position', 'apply', 'salary', 'role', 'opening', 'hiring'];
  if (!jobKeywords.some((kw) => cardText.includes(kw))) {
    return undefined;
  }

  const source = detectJobSource(pageUrl);

  // Extract job link
  let jobUrl: string | undefined;
  for (const selector of LINK_SELECTORS) {
    const href = $card.find(selector).first().attr('href');
    if (!href) continue;

    try {
      const resolved = new URL(href, _base);
      if (tryParseUrl(resolved.toString())) {
        jobUrl = resolved.toString();
        break;
      }
    } catch {
      // Ignore malformed or unresolvable links.
    }
  }

  // Extract title
  let title: string | undefined;
  for (const selector of TITLE_SELECTORS) {
    const text = normalizeText($card.find(selector).first().text());
    if (text) {
      title = text;
      break;
    }
  }
  title ??= normalizeText($card.find('a').first().text());
  if (!title) return undefined;

  // Extract company
  let company: string | undefined;
  for (const selector of COMPANY_SELECTORS) {
    const text = normalizeText($card.find(selector).first().text());
    if (text) {
      company = text;
      break;
    }
  }

  // Extract location
  let location: string | undefined;
  for (const selector of LOCATION_SELECTORS) {
    const text = normalizeText($card.find(selector).first().text());
    if (text) {
      location = text;
      break;
    }
  }

  // Extract salary
  let salaryRaw: string | undefined;
  for (const selector of SALARY_SELECTORS) {
    const text = normalizeText($card.find(selector).first().text());
    if (text) {
      salaryRaw = text;
      break;
    }
  }

  // Extract work mode from card context
  let workMode: WorkMode = 'unknown';
  if (/\bremote\b/i.test(cardText)) workMode = 'remote';
  else if (/\bhybrid\b/i.test(cardText)) workMode = 'hybrid';
  else if (/\bonsite\b|\bon[- ]site\b|\bin[- ]office\b/i.test(cardText)) workMode = 'onsite';

  // Extract job ID from URL
  const jobId = jobUrl ? extractJobIdFromUrl(jobUrl) : undefined;

  const confidence = calculateJobConfidence({ title, location, workMode, salaryRaw });

  // Build listing text from available fields
  const extractedText = [
    title,
    company,
    location,
    workMode !== 'unknown' ? workMode : undefined,
    salaryRaw,
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n');

  const listing: JobListingMvp = {
    title,
    workMode,
    source,
    extractedText,
    confidence,
    verificationStatus: 'search_result_only',
    caveats: [],
  };

  if (company) listing.company = company;
  if (location) listing.location = location;
  if (salaryRaw) listing.salaryRaw = salaryRaw;
  if (jobUrl) listing.sourceUrl = jobUrl;
  if (jobId) listing.jobId = jobId;

  return listing;
}

function tryParseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

// ── Two-phase job discovery ────────────────────────────────────────────────

/** Fast-path patterns for known job boards. Checked first, then heuristic fallback. */
const JOB_URL_PATTERNS: { hostname: RegExp; path: RegExp }[] = [
  // SEEK
  { hostname: /seek\.(?:com\.au|co\.nz)$/, path: /^\/job\/\d+/ },
  // Indeed
  { hostname: /indeed\.com$/, path: /\bjk=[a-f0-9]+/ },
  { hostname: /indeed\.\w+$/, path: /\bjk=[a-f0-9]+/ },
  // LinkedIn
  { hostname: /linkedin\.com$/, path: /\/jobs\/view\// },
  // Jora
  { hostname: /jora\.com$/, path: /\/job\// },
  { hostname: /jora\.\w+$/, path: /\/job\// },
  // Monster
  { hostname: /monster\.com$/, path: /\/job-openings\// },
  { hostname: /monster\.\w+$/, path: /\/job-openings\// },
  // Glassdoor
  { hostname: /glassdoor\.(?:com|co\.uk|co\.in|de|fr|ca)$/, path: /\/Job\// },
  { hostname: /glassdoor\.(?:com|co\.uk|co\.in|de|fr|ca)$/, path: /\/job-listing\// },
  // ZipRecruiter
  { hostname: /ziprecruiter\.com$/, path: /\/jobs\// },
  // CareerBuilder
  { hostname: /careerbuilder\.com$/, path: /\/job\// },
  // Dice
  { hostname: /dice\.com$/, path: /\/job\// },
  { hostname: /dice\.com$/, path: /\/job-detail\// },
  // Workable
  { hostname: /workable\.com$/, path: /\/j\// },
  { hostname: /workable\.com$/, path: /\/jobs\// },
  // Lever
  { hostname: /lever\.co$/, path: /\/[^/]+\/[^/]+$/ },
  // Greenhouse
  { hostname: /greenhouse\.io$/, path: /\/jobs\// },
  // Ashby
  { hostname: /ashbyhq\.com$/, path: /^\/(jobs|positions)\/[^/]+(?:\/.*)?$/ },
  // Breezy
  { hostname: /breezy\.hr$/, path: /\/p\// },
  // Wellfound (AngelList)
  { hostname: /wellfound\.com$/, path: /\/company\/[^/]+\/jobs\// },
  // Otta
  { hostname: /otta\.com$/, path: /\/jobs\// },
  // SimplyHired
  { hostname: /simplyhired\.com$/, path: /\/job\// },
  // FlexJobs
  { hostname: /flexjobs\.com$/, path: /\/jobs\// },
  // Upwork
  { hostname: /upwork\.com$/, path: /\/freelance-jobs\// },
  // Jooble
  { hostname: /jooble\.org$/, path: /\/job\// },
  // Adzuna
  { hostname: /adzuna\.(?:com|co\.uk|de|fr|ca|com\.au)$/, path: /\/job\// },
  { hostname: /adzuna\.(?:com|co\.uk|de|fr|ca|com\.au)$/, path: /\/jobs\// },
];

/** Path segments that strongly suggest a job listing page. */
const JOB_PATH_SEGMENTS = [
  /\/job\//i,
  /\/jobs\//i,
  /\/career\//i,
  /\/careers\//i,
  /\/position\//i,
  /\/positions\//i,
  /\/opening\//i,
  /\/openings\//i,
  /\/vacancy\//i,
  /\/vacancies\//i,
  /\/opportunity\//i,
  /\/opportunities\//i,
  /\/apply\//i,
  /\/role\//i,
  /\/roles\//i,
];

/** Anchor text that should never be treated as a job title. */
const NAV_ANCHOR_PATTERNS =
  /^\s*(?:home|about|contact|login|sign\s*up|register|privacy|terms|blog|faq|help|support|news|press|careers|jobs)\s*$/i;

/** Known job-related data attributes on anchor elements. */
const JOB_DATA_ATTRIBUTES = [
  'data-job-id',
  'data-jobid',
  'data-jobtitle',
  'data-job-title',
  'data-vacancy-id',
  'data-listing-id',
  'data-posting-id',
  'data-automation', // e.g. data-automation="jobTitle"
];

/**
 * Heuristic: does this URL + anchor text look like an individual job posting?
 * Used as a catch-all for job boards not covered by JOB_URL_PATTERNS.
 */
function isLikelyJobUrl(url: URL, anchorText: string | undefined): boolean {
  // Check path segments against job keywords
  const pathLower = url.pathname.toLowerCase();
  const hasJobPathSegment = JOB_PATH_SEGMENTS.some((pattern) => pattern.test(pathLower));

  if (!hasJobPathSegment) {
    // Also check query parameters for job indicators (e.g. ?jk=..., ?job=...)
    const hasJobParam =
      url.searchParams.has('jk') ||
      url.searchParams.has('job') ||
      url.searchParams.has('jobid') ||
      url.searchParams.has('job_id') ||
      url.searchParams.has('jid') ||
      url.searchParams.has('vacancy_id');
    if (!hasJobParam) return false;
  }

  // If we have anchor text, validate it looks like a job title
  if (anchorText && anchorText.trim().length > 0) {
    const text = anchorText.trim();

    // Reject nav-like anchor text
    if (NAV_ANCHOR_PATTERNS.test(text)) return false;

    // Job titles are typically 2+ words, at least 10 chars, and contain a capital
    const wordCount = text.split(/\s+/).length;
    if (wordCount < 2 && text.length < 12) return false;

    // Reject single-word anchors that are just job keywords
    if (wordCount === 1 && /\b(job|career|position|opening|vacancy)\b/i.test(text)) return false;
  }

  return true;
}

/**
 * Extract job listing links from HTML. Uses three strategies:
 * 1. Known JOB_URL_PATTERNS (fast path for popular boards)
 * 2. Heuristic URL + anchor text detection (catch-all for any board)
 * 3. DOM structure cues (data attributes, schema.org itemprop)
 *
 * Allows external domains so aggregator pages can link to individual job pages
 * hosted on different domains.
 */
export function extractJobLinksFromHtml(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  const $ = cheerio.load(html);

  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href');
    if (!href) return;

    let resolved: URL;
    try {
      resolved = new URL(href, base);
    } catch {
      return;
    }

    // Skip obviously non-job URLs early
    const pathLower = resolved.pathname.toLowerCase();
    if (
      /(\.(jpg|png|gif|svg|webp|css|js|ico|pdf|xml|rss|atom)|\/cdn\/|\/static\/|\/assets\/)/i.test(
        pathLower,
      )
    )
      return;

    // Strategy 1: known board patterns
    for (const { hostname, path } of JOB_URL_PATTERNS) {
      if (hostname.test(resolved.hostname) && path.test(resolved.pathname + resolved.search)) {
        links.add(resolved.href);
        return;
      }
    }

    // Strategy 2: heuristic URL + anchor text detection
    const anchorText = normalizeText($el.text());
    if (isLikelyJobUrl(resolved, anchorText)) {
      links.add(resolved.href);
      return;
    }

    // Strategy 3: DOM data attributes
    for (const attr of JOB_DATA_ATTRIBUTES) {
      if ($el.attr(attr) !== undefined) {
        links.add(resolved.href);
        return;
      }
    }

    // Strategy 4: schema.org microdata — anchor with itemprop="url" inside a JobPosting container
    const itempropUrl = $el.attr('itemprop');
    if (itempropUrl === 'url') {
      // Walk up to see if we're inside a JobPosting
      const $parent = $el.closest('[itemtype*="JobPosting"], [itemtype*="jobposting"]');
      if ($parent.length > 0) {
        links.add(resolved.href);
        return;
      }
    }
  });

  return [...links];
}

function normalizeText(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : undefined;
}

function loadHtml(html: string): cheerio.CheerioAPI {
  return cheerio.load(html);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract a meaningful title from raw page text when no structured title was found.
 * Looks for the first substantial line that looks like a heading or job title.
 */
function tryExtractMeaningfulTitle(pageText: string): string | undefined {
  const lines = pageText.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip lines that are clearly nav/boilerplate
    if (trimmed.length < 10) continue;
    if (
      /^(home|about|contact|login|sign up|register|privacy|terms|blog|faq|help|support|news|press|careers?|jobs?|search|menu)$/i.test(
        trimmed,
      )
    )
      continue;
    if (/^(\d+|\W+)$/.test(trimmed)) continue;
    // Heuristic: a good title is 2-10 words, starts with a capital letter
    const words = trimmed.split(/\s+/);
    if (words.length >= 2 && words.length <= 12 && /^[A-Z]/.test(trimmed)) {
      return trimmed;
    }
  }
  return undefined;
}
