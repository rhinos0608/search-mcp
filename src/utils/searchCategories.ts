/**
 * Category profiles for web search query enhancement.
 *
 * Each profile provides hints, preferred domains, and required text terms
 * to refine search results when a category is specified.
 */

export interface CategoryProfile {
  queryHint: string;
}

export const CATEGORY_NAMES = [
  'company',
  'research paper',
  'news',
  'pdf',
  'github',
  'tweet',
  'personal site',
  'people',
  'financial report',
] as const;

const EMPTY_PROFILE: CategoryProfile = {
  queryHint: '',
};

export const SEARCH_CATEGORIES: Record<string, CategoryProfile> = {
  company: {
    queryHint: 'official site products services company overview funding news',
  },
  'research paper': {
    queryHint: 'research paper arxiv preprint',
  },
  news: {
    queryHint: 'latest news',
  },
  pdf: {
    queryHint: 'pdf',
  },
  github: {
    queryHint: 'github repository',
  },
  tweet: {
    queryHint: 'x twitter thread',
  },
  'personal site': {
    queryHint: 'personal blog portfolio',
  },
  people: {
    queryHint: 'biography profile',
  },
  'financial report': {
    queryHint: 'annual report 10-k earnings',
  },
};

export function getCategoryProfile(name: string): CategoryProfile {
  return SEARCH_CATEGORIES[name] ?? EMPTY_PROFILE;
}