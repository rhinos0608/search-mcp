export type JobSource = 'seek' | 'indeed' | 'jora' | 'other';
export type WorkMode = 'onsite' | 'hybrid' | 'remote' | 'unknown';
export type VerificationStatus =
  | 'listing_page_fetched'
  | 'search_result_only'
  | 'aggregator_result'
  | 'needs_manual_check';

export interface JobFieldConfidence {
  title: number;
  location: number;
  workMode: number;
  salary: number;
  overall: number;
}

// ── MVP type (kept for backward compatibility) ───────────────────────────

export interface JobListingMvp {
  title: string;
  company?: string;
  location?: string;
  workMode: WorkMode;
  salaryRaw?: string;
  source: JobSource;
  sourceUrl?: string;
  jobId?: string;
  postedRaw?: string;
  extractedText: string;
  confidence: JobFieldConfidence;
  verificationStatus: VerificationStatus;
  caveats: string[];
}

// ── Enhanced salary structure ──────────────────────────────────────────────

export interface SalaryRange {
  min?: number;
  max?: number;
  currency?: string;
  unit: 'hour' | 'day' | 'week' | 'month' | 'year';
  raw: string; // Original text
}

// ── Experience requirements ────────────────────────────────────────────────

export interface ExperienceRange {
  min?: number;
  max?: number;
  unit: 'month' | 'year';
}

// ── Structured requirements ────────────────────────────────────────────────

export interface JobRequirement {
  category: 'essential' | 'preferred' | 'nice_to_have';
  skill?: string;
  years?: number;
  description: string;
}

// ── Full job listing (replaces/extends MVP) ───────────────────────────────

export interface JobListing {
  // Core fields
  title: string;
  company?: string;
  location?: string;
  workMode: WorkMode;

  // Structured salary
  salary?: SalaryRange;

  // Experience
  seniority?: 'entry' | 'mid' | 'senior' | 'lead' | 'executive';
  experience?: ExperienceRange;

  // Requirements
  requirements: JobRequirement[];
  niceToHave?: string[];

  // Application
  applyUrl?: string;

  // Metadata
  source: JobSource;
  sourceUrl?: string;
  jobId?: string;

  // Dates
  postedAt?: Date | null;
  expiresAt?: Date | null;

  // Search/retrieval
  extractedText: string;
  confidence: JobFieldConfidence;
  verificationStatus: VerificationStatus;
  caveats: string[];

  // Embeddings for semantic dedup
  embedding?: number[];
  bm25Tokens?: string[];
}

// ── Search constraints ─────────────────────────────────────────────────────

export interface JobSearchConstraints {
  location?: string[];
  workMode?: WorkMode[];
  maxSalary?: number;
  excludeTitles?: string[];
}
