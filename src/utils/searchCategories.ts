/**
 * Category profiles for web search query enhancement.
 *
 * Each profile provides hints, preferred domains, and required text terms
 * to refine search results when a category is specified.
 */

export interface CategoryProfile {
  queryHint: string;
  includeDomains: string[];
  includeText: string[];
}

const EMPTY_PROFILE: CategoryProfile = {
  queryHint: '',
  includeDomains: [],
  includeText: [],
};

export const SEARCH_CATEGORIES: Record<string, CategoryProfile> = {
  company: {
    queryHint: 'official site products services company overview funding news',
    includeDomains: [],
    includeText: ['company'],
  },
  'research paper': {
    queryHint: 'research paper arxiv preprint',
    includeDomains: ['arxiv.org', 'openreview.net', 'acm.org', 'ieee.org'],
    includeText: ['abstract'],
  },
  news: {
    queryHint: 'latest news',
    includeDomains: [],
    includeText: ['news'],
  },
  pdf: {
    queryHint: 'filetype:pdf pdf',
    includeDomains: [],
    includeText: [],
  },
  github: {
    queryHint: 'github repository',
    includeDomains: ['github.com'],
    includeText: [],
  },
  tweet: {
    queryHint: 'x twitter thread',
    includeDomains: ['x.com', 'twitter.com'],
    includeText: [],
  },
  'personal site': {
    queryHint: 'personal blog portfolio',
    includeDomains: [],
    includeText: ['about'],
  },
  people: {
    queryHint: 'biography profile',
    includeDomains: [],
    includeText: [],
  },
  'financial report': {
    queryHint: 'annual report 10-k earnings',
    includeDomains: ['sec.gov'],
    includeText: ['annual report', '10-k', 'earnings'],
  },
};

export function getCategoryProfile(name: string): CategoryProfile {
  return SEARCH_CATEGORIES[name] ?? EMPTY_PROFILE;
}