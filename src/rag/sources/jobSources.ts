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
  other: {
    source: 'other',
    hostPatterns: [],
    reliability: 'low',
    dynamicRisk: 'low',
    duplicateRisk: 'medium',
    structuredDataLikely: false,
  },
};

/** Extended source profiles for job search — covers additional job boards globally. */
export const EXTENDED_SOURCE_PATTERNS: { source: JobSource; patterns: RegExp[] }[] = [
  {
    source: 'seek',
    patterns: [
      /^(?:[^.]+\.)*seek\.(?:com\.au|co\.nz|com)$/i,
    ],
  },
  {
    source: 'indeed',
    patterns: [
      /^(?:[^.]+\.)*indeed\.com$/i,
    ],
  },
  {
    source: 'jora',
    patterns: [
      /^(?:[^.]+\.)*jora\.com$/i,
    ],
  },
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
  return SOURCE_PROFILES[source] ?? SOURCE_PROFILES.other;
}
