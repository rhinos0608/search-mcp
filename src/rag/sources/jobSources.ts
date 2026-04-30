import type { JobSource } from '../types/job.js';

export interface JobSourceProfile {
  source: JobSource;
  hostPatterns: RegExp[];
  reliability: 'high' | 'medium' | 'low';
  dynamicRisk: 'none' | 'low' | 'medium' | 'high' | 'very_high';
  duplicateRisk: 'low' | 'medium' | 'high';
  structuredDataLikely: boolean;
}

export const SOURCE_PROFILES: Record<JobSource, JobSourceProfile> = {
  seek: {
    source: 'seek',
    hostPatterns: [/^(?:[^.]+\.)*seek\.(?:com\.au|co\.nz|com)$/i],
    reliability: 'high',
    dynamicRisk: 'medium',
    duplicateRisk: 'low',
    structuredDataLikely: true,
  },
  indeed: {
    source: 'indeed',
    hostPatterns: [/^(?:[^.]+\.)*indeed\.com$/i],
    reliability: 'high',
    dynamicRisk: 'medium',
    duplicateRisk: 'medium',
    structuredDataLikely: true,
  },
  jora: {
    source: 'jora',
    hostPatterns: [/^(?:[^.]+\.)*jora\.com$/i],
    reliability: 'medium',
    dynamicRisk: 'low',
    duplicateRisk: 'high',
    structuredDataLikely: false,
  },
  linkedin: {
    source: 'linkedin',
    hostPatterns: [/^(?:[^.]+\.)*linkedin\.com$/i],
    reliability: 'high',
    dynamicRisk: 'medium',
    duplicateRisk: 'low',
    structuredDataLikely: true,
  },
  monster: {
    source: 'monster',
    hostPatterns: [/^(?:[^.]+\.)*monster\.com$/i],
    reliability: 'medium',
    dynamicRisk: 'medium',
    duplicateRisk: 'medium',
    structuredDataLikely: true,
  },
  glassdoor: {
    source: 'glassdoor',
    hostPatterns: [/^(?:[^.]+\.)*glassdoor\.(?:com|co\.uk|co\.in|de|fr|ca)$/i],
    reliability: 'medium',
    dynamicRisk: 'medium',
    duplicateRisk: 'medium',
    structuredDataLikely: true,
  },
  ziprecruiter: {
    source: 'ziprecruiter',
    hostPatterns: [/^(?:[^.]+\.)*ziprecruiter\.com$/i],
    reliability: 'medium',
    dynamicRisk: 'low',
    duplicateRisk: 'medium',
    structuredDataLikely: true,
  },
  careerbuilder: {
    source: 'careerbuilder',
    hostPatterns: [/^(?:[^.]+\.)*careerbuilder\.com$/i],
    reliability: 'medium',
    dynamicRisk: 'medium',
    duplicateRisk: 'medium',
    structuredDataLikely: true,
  },
  dice: {
    source: 'dice',
    hostPatterns: [/^(?:[^.]+\.)*dice\.com$/i],
    reliability: 'medium',
    dynamicRisk: 'low',
    duplicateRisk: 'medium',
    structuredDataLikely: true,
  },
  workable: {
    source: 'workable',
    hostPatterns: [/^(?:[^.]+\.)*workable\.com$/i],
    reliability: 'medium',
    dynamicRisk: 'low',
    duplicateRisk: 'low',
    structuredDataLikely: true,
  },
  lever: {
    source: 'lever',
    hostPatterns: [/^(?:[^.]+\.)*lever\.co$/i],
    reliability: 'medium',
    dynamicRisk: 'low',
    duplicateRisk: 'low',
    structuredDataLikely: true,
  },
  greenhouse: {
    source: 'greenhouse',
    hostPatterns: [/^(?:[^.]+\.)*greenhouse\.io$/i],
    reliability: 'medium',
    dynamicRisk: 'low',
    duplicateRisk: 'low',
    structuredDataLikely: true,
  },
  ashby: {
    source: 'ashby',
    hostPatterns: [/^(?:[^.]+\.)*ashbyhq\.com$/i],
    reliability: 'medium',
    dynamicRisk: 'low',
    duplicateRisk: 'low',
    structuredDataLikely: true,
  },
  breezy: {
    source: 'breezy',
    hostPatterns: [/^(?:[^.]+\.)*breezy\.hr$/i],
    reliability: 'medium',
    dynamicRisk: 'low',
    duplicateRisk: 'low',
    structuredDataLikely: true,
  },
  wellfound: {
    source: 'wellfound',
    hostPatterns: [/^(?:[^.]+\.)*wellfound\.com$/i],
    reliability: 'medium',
    dynamicRisk: 'low',
    duplicateRisk: 'low',
    structuredDataLikely: true,
  },
  otta: {
    source: 'otta',
    hostPatterns: [/^(?:[^.]+\.)*otta\.com$/i],
    reliability: 'medium',
    dynamicRisk: 'low',
    duplicateRisk: 'low',
    structuredDataLikely: true,
  },
  simplyhired: {
    source: 'simplyhired',
    hostPatterns: [/^(?:[^.]+\.)*simplyhired\.com$/i],
    reliability: 'medium',
    dynamicRisk: 'low',
    duplicateRisk: 'medium',
    structuredDataLikely: true,
  },
  flexjobs: {
    source: 'flexjobs',
    hostPatterns: [/^(?:[^.]+\.)*flexjobs\.com$/i],
    reliability: 'medium',
    dynamicRisk: 'low',
    duplicateRisk: 'low',
    structuredDataLikely: true,
  },
  upwork: {
    source: 'upwork',
    hostPatterns: [/^(?:[^.]+\.)*upwork\.com$/i],
    reliability: 'medium',
    dynamicRisk: 'low',
    duplicateRisk: 'low',
    structuredDataLikely: true,
  },
  jooble: {
    source: 'jooble',
    hostPatterns: [/^(?:[^.]+\.)*jooble\.org$/i],
    reliability: 'low',
    dynamicRisk: 'low',
    duplicateRisk: 'high',
    structuredDataLikely: false,
  },
  adzuna: {
    source: 'adzuna',
    hostPatterns: [/^(?:[^.]+\.)*adzuna\.(?:com|co\.uk|de|fr|ca|com\.au)$/i],
    reliability: 'medium',
    dynamicRisk: 'low',
    duplicateRisk: 'high',
    structuredDataLikely: true,
  },
  other: {
    source: 'other',
    hostPatterns: [],
    reliability: 'low',
    dynamicRisk: 'low',
    duplicateRisk: 'medium',
    structuredDataLikely: false,
  },
};

/** Extended source patterns for job search — covers additional job boards globally. */
export const EXTENDED_SOURCE_PATTERNS: { source: JobSource; patterns: RegExp[] }[] = [
  { source: 'seek', patterns: [/^(?:[^.]+\.)*seek\.(?:com\.au|co\.nz|com)$/i] },
  { source: 'indeed', patterns: [/^(?:[^.]+\.)*indeed\.com$/i] },
  { source: 'jora', patterns: [/^(?:[^.]+\.)*jora\.com$/i] },
  { source: 'linkedin', patterns: [/^(?:[^.]+\.)*linkedin\.com$/i] },
  { source: 'monster', patterns: [/^(?:[^.]+\.)*monster\.com$/i] },
  { source: 'glassdoor', patterns: [/^(?:[^.]+\.)*glassdoor\.(?:com|co\.uk|co\.in|de|fr|ca)$/i] },
  { source: 'ziprecruiter', patterns: [/^(?:[^.]+\.)*ziprecruiter\.com$/i] },
  { source: 'careerbuilder', patterns: [/^(?:[^.]+\.)*careerbuilder\.com$/i] },
  { source: 'dice', patterns: [/^(?:[^.]+\.)*dice\.com$/i] },
  { source: 'workable', patterns: [/^(?:[^.]+\.)*workable\.com$/i] },
  { source: 'lever', patterns: [/^(?:[^.]+\.)*lever\.co$/i] },
  { source: 'greenhouse', patterns: [/^(?:[^.]+\.)*greenhouse\.io$/i] },
  { source: 'ashby', patterns: [/^(?:[^.]+\.)*ashbyhq\.com$/i] },
  { source: 'breezy', patterns: [/^(?:[^.]+\.)*breezy\.hr$/i] },
  { source: 'wellfound', patterns: [/^(?:[^.]+\.)*wellfound\.com$/i] },
  { source: 'otta', patterns: [/^(?:[^.]+\.)*otta\.com$/i] },
  { source: 'simplyhired', patterns: [/^(?:[^.]+\.)*simplyhired\.com$/i] },
  { source: 'flexjobs', patterns: [/^(?:[^.]+\.)*flexjobs\.com$/i] },
  { source: 'upwork', patterns: [/^(?:[^.]+\.)*upwork\.com$/i] },
  { source: 'jooble', patterns: [/^(?:[^.]+\.)*jooble\.org$/i] },
  { source: 'adzuna', patterns: [/^(?:[^.]+\.)*adzuna\.(?:com|co\.uk|de|fr|ca|com\.au)$/i] },
];

/** Detect the job source from a URL. Falls back to 'other' for unrecognized domains. */
export function detectJobSource(url: string): JobSource {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    // Check known sources first
    for (const profile of Object.values(SOURCE_PROFILES)) {
      if (profile.source === 'other') continue;
      if (profile.hostPatterns.some((pattern) => pattern.test(hostname))) {
        return profile.source;
      }
    }

    // Heuristic: common job board keywords in hostname
    if (/\b(jobs?|careers?|hire|recruit|work|apply|linkedin)\b/i.test(hostname)) {
      return 'other';
    }
  } catch {
    return 'other';
  }

  return 'other';
}

export function getSourceProfile(source: JobSource): JobSourceProfile {
  return SOURCE_PROFILES[source];
}
