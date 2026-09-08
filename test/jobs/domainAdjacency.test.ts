import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DomainPackSchema } from '../../src/jobs/packs/types.js';
import { NSW_PUBLIC_ADMIN_DOMAIN_PACK } from '../../src/jobs/packs/nswPublicAdmin.domain.js';
import { scoreRoleFamily } from '../../src/jobs/retrieval/channels/roleFamily.js';
import { scoreCapabilityOverlap } from '../../src/jobs/retrieval/channels/capabilityOverlap.js';

const PACK = DomainPackSchema.parse(NSW_PUBLIC_ADMIN_DOMAIN_PACK);

// Every required family: roleNodes present in the pack.
const REQUIRED_FAMILIES = [
  'Regulatory Officer',
  'Intelligence Officer',
  'Investigations Officer',
  'Integrity Officer',
  'Policy Analyst',
  'Research Officer',
  'Court Registry Officer',
  'Public Administration Officer',
  'Health Administration Officer',
  'University Administration Officer',
  'Local Government Officer',
  'Service Operations Officer',
  'Project Support Officer',
  'General Administration Officer',
] as const;

function roleMap(entries: readonly (readonly [string, readonly string[]])[]) {
  return new Map<string, readonly string[]>(entries);
}

describe('domain adjacency: every family linked, distinguishable, no equivalence', () => {
  test('RED: pack has no equivalent_title edges (no arbitrary equivalence)', () => {
    const equiv = PACK.edges.filter((e) => e.type === 'equivalent_title');
    assert.deepEqual(equiv, []);
  });

  for (const family of REQUIRED_FAMILIES) {
    test(`role-family isolated: ${family} scores 1.0 on exact match`, () => {
      const result = scoreRoleFamily({
        intentRoleFamilies: [family],
        candidateRoleFamilies: roleMap([
          ['cand-match', [family]],
          ['cand-other', ['Unrelated Rocket Scientist']],
        ]),
        domainPack: PACK,
      });
      const byId = new Map(result.entries.map((e) => [e.candidateId, e.score]));
      assert.equal(byId.get('cand-match'), 1.0);
      // Unresolvable 'Unrelated Rocket Scientist' is omitted from entries;
      // RRF fusion treats absent as neutral 0.5 — distinguishable from 1.0.
      assert.ok(!byId.has('cand-other'), 'unrelated unresolvable role omitted (neutral via RRF)');
      assert.equal(result.fullyScored, false);
    });
  }

  test('adjacent/capability-transfer link beats distant role', () => {
    // Intelligence Officer <-> Investigations Officer are adjacent per pack;
    // Service Operations Officer sits in a distant cluster.
    const result = scoreRoleFamily({
      intentRoleFamilies: ['Intelligence Officer'],
      candidateRoleFamilies: roleMap([
        ['cand-adj', ['Investigations Officer']],
        ['cand-distant', ['Service Operations Officer']],
      ]),
      domainPack: PACK,
    });
    const byId = new Map(result.entries.map((e) => [e.candidateId, e.score]));
    assert.ok(byId.has('cand-adj') && byId.has('cand-distant'), 'both resolvable must score');
    assert.ok(
      (byId.get('cand-adj') ?? 0) > (byId.get('cand-distant') ?? 1),
      `adjacent must beat distant: ${byId.get('cand-adj')} vs ${byId.get('cand-distant')}`,
    );
  });

  test('every required family has an adjacent/capability-transfer link', () => {
    // Each family must be distinguishable via at least one evidence-backed
    // adjacent or capability_transfer edge (no isolated or equivalence-only nodes).
    const linked = new Set<string>();
    for (const e of PACK.edges) {
      if (e.type === 'adjacent' || e.type === 'capability_transfer') {
        linked.add(e.from);
        linked.add(e.to);
      }
    }
    const nodeIds = new Set(PACK.roleNodes.map((n) => n.id));
    const labelToId = new Map(PACK.roleNodes.map((n) => [n.label, n.id]));
    for (const family of REQUIRED_FAMILIES) {
      const id = labelToId.get(family);
      assert.ok(id && nodeIds.has(id), `${family} present in pack`);
      assert.ok(linked.has(id), `${family} has adjacent/capability-transfer link`);
    }
  });

  test('capability overlap: shared capabilities beat disjoint', () => {
    const result = scoreCapabilityOverlap({
      intentCapabilities: ['investigation', 'reporting'],
      intentRoleFamilies: [],
      candidateRoleFamilies: roleMap([
        ['cand-overlap', ['Investigations Officer']],
        ['cand-disjoint', ['General Administration Officer']],
      ]),
      domainPack: PACK,
    });
    const byId = new Map(result.entries.map((e) => [e.candidateId, e.score]));
    assert.ok(
      (byId.get('cand-overlap') ?? 0) > (byId.get('cand-disjoint') ?? 1),
      'overlap must beat disjoint capabilities',
    );
  });

  test('unknown stays unknown: unresolvable intent family yields no false match', () => {
    const result = scoreRoleFamily({
      intentRoleFamilies: ['Nonexistent Martian Role'],
      candidateRoleFamilies: roleMap([['cand-a', ['Regulatory Officer']]]),
      domainPack: PACK,
    });
    // Unresolvable intent => no entries (neutral 0.5 via RRF absent rule),
    // never a fabricated match score.
    assert.deepEqual(result.entries, []);
    assert.equal(result.fullyScored, false);
  });

  test('pack terminology never infers eligibility: unknown remains unknown', () => {
    // requirementTerminology maps only explicit spans; unknown terms unmapped.
    assert.ok(!('unknown term xyz' in PACK.requirementTerminology));
    assert.equal(PACK.requirementTerminology['working with children check'], 'employment_check');
  });

  test('SEEK source contributions not activated by packs', () => {
    assert.ok(!PACK.evidenceCitations.some((c) => /seek/i.test(c)));
  });
});
