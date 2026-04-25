import * as cheerio from 'cheerio';

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
  /\$\d+(?:\.\d+)?k\s*[–-]\s*\$?\d+(?:\.\d+)?k/i,
  /\$\d+(?:\.\d+)?k\s*\+\s*super/i,
];

export function extractJobListingsFromHtml(html: string, url: string): JobListingMvp[] {
  const source = detectJobSource(url);
  const jsonLdListings = extractJobPostingsFromJsonLd(html);

  if (jsonLdListings.length > 0) {
    return jsonLdListings
      .map((jobPosting) => buildListing(html, url, source, jobPosting))
      .filter((listing): listing is JobListingMvp => listing !== undefined);
  }

  const listing = buildListing(html, url, source);
  return listing ? [listing] : [];
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
      adapter: 'search',
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
