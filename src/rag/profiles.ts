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
  fast: {
    profile: 'fast',
    topK: 10,
    vectorWeight: 1,
    lexicalWeight: 0.8,
    rrfK: 60,
    useReranker: false,
  },
  precision: {
    profile: 'precision',
    topK: 10,
    vectorWeight: 1,
    lexicalWeight: 1,
    rrfK: 60,
    useReranker: true,
  },
  recall: {
    profile: 'recall',
    topK: 20,
    vectorWeight: 1,
    lexicalWeight: 1,
    rrfK: 60,
    useReranker: false,
  },
};

export function getProfileSettings(
  profile: RetrievalProfileName = 'balanced',
  overrides?: Partial<Omit<ProfileSettings, 'profile'>>,
): ProfileSettings {
  return {
    ...PROFILE_DEFAULTS[profile],
    ...overrides,
    profile,
  };
}
