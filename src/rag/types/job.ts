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

export interface JobSearchConstraints {
  location?: string[];
  workMode?: WorkMode[];
  maxSalary?: number;
  excludeTitles?: string[];
}
