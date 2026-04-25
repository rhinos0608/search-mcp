import type { ProfileSettings, RetrievalProfileName } from './types.js';

const PROFILE_DEFAULTS: Record<RetrievalProfileName, ProfileSettings> = {
  balanced: {
    profile: 'balanced',
    topK: 10,
    vectorWeight: 1,
    lexicalWeight: 1,
    rrfK: 60,
    useReranker: false,
  },
  'lexical-heavy': {
    profile: 'lexical-heavy',
    topK: 10,
    vectorWeight: 0.85,
    lexicalWeight: 1.35,
    rrfK: 60,
    useReranker: false,
  },
  'semantic-heavy': {
    profile: 'semantic-heavy',
    topK: 10,
    vectorWeight: 1.2,
    lexicalWeight: 0.85,
    rrfK: 60,
    useReranker: false,
  },
  'high-precision': {
    profile: 'high-precision',
    topK: 10,
    vectorWeight: 1,
    lexicalWeight: 1,
    rrfK: 60,
    useReranker: true,
  },
  fast: {
    profile: 'fast',
    topK: 10,
    vectorWeight: 1,
    lexicalWeight: 0.8,
    rrfK: 60,
    useReranker: false,
  },
  precision: {
    profile: 'high-precision',
    topK: 10,
    vectorWeight: 1,
    lexicalWeight: 1,
    rrfK: 60,
    useReranker: true,
  },
  recall: {
    profile: 'semantic-heavy',
    topK: 20,
    vectorWeight: 1.2,
    lexicalWeight: 0.9,
    rrfK: 60,
    useReranker: false,
  },
};

function normalizeProfile(profile: RetrievalProfileName): RetrievalProfileName {
  switch (profile) {
    case 'precision':
      return 'high-precision';
    case 'recall':
      return 'semantic-heavy';
    default:
      return profile;
  }
}

export function getProfileSettings(
  profile: RetrievalProfileName = 'balanced',
  overrides?: Partial<Omit<ProfileSettings, 'profile'>>,
): ProfileSettings {
  const normalized = normalizeProfile(profile);
  return {
    ...PROFILE_DEFAULTS[normalized],
    ...overrides,
    profile: normalized,
  };
}
