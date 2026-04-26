import type { GoldenQuery, GoldenQueriesIndex } from '../metrics.js';
import academicQueries from './academic-queries.json' with { type: 'json' };
import qaQueries from './qa-queries.json' with { type: 'json' };
import generalQueries from './general-queries.json' with { type: 'json' };
import jobQueries from './job-queries.json' with { type: 'json' };

export const goldenQueries: GoldenQueriesIndex = {
  academic: academicQueries as GoldenQuery[],
  qa: qaQueries as GoldenQuery[],
  general: generalQueries as GoldenQuery[],
  job: jobQueries as GoldenQuery[],
};

export function getQueriesByDomain(domain: string): GoldenQuery[] {
const key = domain as keyof GoldenQueriesIndex; // eslint-disable-line @typescript-eslint/no-unnecessary-type-assertion
  const queries = goldenQueries[key];
  return queries ?? [];
}

export function getAllQueries(): GoldenQuery[] {
  const all: GoldenQuery[] = [];
  for (const domain of Object.values(goldenQueries)) {
    all.push(...domain);
  }
  return all;
}
