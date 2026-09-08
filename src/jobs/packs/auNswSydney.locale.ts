/**
 * AU/NSW/Sydney locale pack (Checkpoint B capability).
 *
 * Versioned, evidence-cited locale intelligence: geography hierarchy
 * (country → state → city → postcode/LGA/health district), AUD salary
 * conventions, NSW classification schemes, and eligibility terminology.
 * Generic core stays assumption-free; everything here applies ONLY when
 * this pack is explicitly selected and configured.
 */

import { LocalePackSchema, type LocalePack } from './types.js';
import { freeze } from './freeze.js';

const DETERMINISTIC_RULE = (ruleId: string, description: string) => ({
  ruleId,
  version: '1.0.0',
  deterministic: true as const,
  description,
});

export const AU_NSW_SYDNEY_LOCALE_PACK: LocalePack = freeze(
  LocalePackSchema.parse({
    kind: 'locale',
    id: 'au-nsw-sydney',
    version: '1.0.0',
    effectiveFrom: '2026-01-01',
    attribution: {
      author: 'search-mcp jobs subsystem',
      license: 'MIT',
      source: 'docs/jobs/adr/ADR-004-core-and-packs.md',
    },
    geography: [
      {
        id: 'au',
        name: 'Australia',
        kind: 'country',
        aliases: ['AU', 'Commonwealth of Australia'],
      },
      {
        id: 'nsw',
        name: 'New South Wales',
        kind: 'state',
        parentId: 'au',
        aliases: ['NSW'],
      },
      { id: 'sydney', name: 'Sydney', kind: 'city', parentId: 'nsw', aliases: ['Syd'] },
      {
        id: 'sydney-cbd',
        name: 'Sydney CBD',
        kind: 'region',
        parentId: 'sydney',
        aliases: ['CBD'],
      },
      { id: 'parramatta', name: 'Parramatta', kind: 'city', parentId: 'nsw', aliases: [] },
      {
        id: 'sydney-2000',
        name: 'Sydney 2000',
        kind: 'postcode',
        parentId: 'sydney-cbd',
        aliases: ['2000'],
      },
      {
        id: 'parramatta-2150',
        name: 'Parramatta 2150',
        kind: 'postcode',
        parentId: 'parramatta',
        aliases: ['2150'],
      },
      {
        id: 'city-of-sydney',
        name: 'City of Sydney',
        kind: 'lga',
        parentId: 'sydney',
        aliases: [],
      },
      {
        id: 'city-of-parramatta',
        name: 'City of Parramatta',
        kind: 'lga',
        parentId: 'parramatta',
        aliases: [],
      },
      {
        id: 'seslhd',
        name: 'South Eastern Sydney Local Health District',
        kind: 'health_district',
        parentId: 'sydney',
        aliases: ['SESLHD'],
      },
      {
        id: 'wslhd',
        name: 'Western Sydney Local Health District',
        kind: 'health_district',
        parentId: 'parramatta',
        aliases: ['WSLHD'],
      },
    ],
    salaryConventions: [
      { currency: 'AUD', period: 'year', includesSuperannuation: false },
      { currency: 'AUD', period: 'hour', includesSuperannuation: false },
      { currency: 'AUD', period: 'day', includesSuperannuation: false },
      { currency: 'AUD', period: 'week', includesSuperannuation: false },
    ],
    classificationSchemes: [
      {
        id: 'anzsco',
        name: 'Australian and New Zealand Standard Classification of Occupations',
        version: '1.0.0',
        values: ['133211', '224712', '262111', '272311'],
      },
      {
        id: 'nsw-band',
        name: 'NSW Public Sector Classification and Remuneration Bands',
        version: '1.0.0',
        values: ['Clerk Grade 3/4', 'Clerk Grade 5/6', 'Clerk Grade 7/8', 'Senior Officer'],
      },
    ],
    eligibilityTerminology: {
      working_with_children_check: 'WWCC',
      national_police_check: 'NPC',
      australian_work_rights: 'work_rights',
    },
    sourceRegistryContributions: ['board:seek', 'ats:successfactors-nsw'],
    normalizationRules: [
      DETERMINISTIC_RULE('geo-alias-nsw', 'Resolve NSW/Sydney aliases via geography nodes only.'),
      DETERMINISTIC_RULE(
        'salary-aud-convention',
        'AUD salary conventions apply only when currency is explicitly AUD.',
      ),
    ],
    evaluationFixtures: [{ id: 'sydney-geo-basic', path: 'fixtures/sydney/geo.json' }],
  }),
);
