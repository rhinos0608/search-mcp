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

export function detectJobSource(url: string): JobSource {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    for (const profile of Object.values(SOURCE_PROFILES)) {
      if (profile.source === 'other') {
        continue;
      }

      if (profile.hostPatterns.some((pattern) => pattern.test(hostname))) {
        return profile.source;
      }
    }
  } catch {
    return 'other';
  }

  return 'other';
}

export function getSourceProfile(source: JobSource): JobSourceProfile {
  return SOURCE_PROFILES[source];
}
