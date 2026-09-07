import type { ClaimCandidate } from '../domain/claims.js';
import type { Evidence } from '../domain/evidence.js';
import { expandDomainTerms } from '../packs/expansion.js';
import { deterministicEnrichmentId } from './ids.js';
import type {
  DomainPack,
  EnrichmentWarning,
  ExtractedFieldSnapshot,
  LocalePack,
} from './contracts.js';

export interface ListingEnrichmentResult {
  readonly derivedClaimCandidates: ClaimCandidate<unknown>[];
  readonly derivedEvidence: Evidence[];
  readonly roleFamilies: readonly { family: string; confidence: number; evidenceRefs: string[] }[];
  readonly requirementsInterpreted: readonly unknown[];
  readonly warnings: EnrichmentWarning[];
}

export function enrichListing(
  snapshot: ExtractedFieldSnapshot,
  localePack: LocalePack | undefined,
  domainPack: DomainPack | undefined,
  clock: { producedAt: string },
): ListingEnrichmentResult {
  const derivedClaimCandidates: ClaimCandidate<unknown>[] = [];
  const derivedEvidence: Evidence[] = [];
  const roleFamilies: { family: string; confidence: number; evidenceRefs: string[] }[] = [];
  const warnings: EnrichmentWarning[] = [];

  // Geography binding
  if (localePack && snapshot.locations) {
    for (const location of snapshot.locations) {
      for (const node of localePack.geography) {
        const nameMatch =
          location.city?.toLocaleLowerCase() === node.name.toLocaleLowerCase() ||
          location.region?.toLocaleLowerCase() === node.name.toLocaleLowerCase() ||
          location.postcode?.toLocaleLowerCase() === node.name.toLocaleLowerCase();
        const aliasMatch = node.aliases.some(
          (alias) =>
            location.city?.toLocaleLowerCase() === alias.toLocaleLowerCase() ||
            location.region?.toLocaleLowerCase() === alias.toLocaleLowerCase() ||
            location.postcode?.toLocaleLowerCase() === alias.toLocaleLowerCase(),
        );
        if (nameMatch || aliasMatch) {
          const evidenceId = deterministicEnrichmentId('evidence', [
            'structured_field',
            'posting',
            `locations:${node.id}`,
            node.name,
          ]);
          derivedEvidence.push({
            evidenceId: evidenceId as never,
            subjectType: 'posting',
            subjectId: 'locations',
            fieldPath: 'locations',
            kind: 'structured_field',
            capturedAt: clock.producedAt,
            confidence: 0.6,
            retentionClass: 'enrichment_ephemeral',
          });

          const claimId = deterministicEnrichmentId('claim', [
            'locations',
            'deterministic_derived',
            node.id,
            'listing-geo',
          ]);
          derivedClaimCandidates.push({
            candidateId: claimId as never,
            value: { matchedNodeId: node.id, name: node.name, kind: node.kind },
            evidenceRefs: [evidenceId] as never[],
            confidence: 0.6,
            origin: 'deterministic_derived',
            method: 'listing-geo',
            provenance: {
              component: 'jobs.enrichment',
              version: '1.0.0',
              producedAt: clock.producedAt,
            },
          });
        }
      }
    }
  }

  // Role family expansion
  if (domainPack && (snapshot.title || (snapshot.roleFamilyHints?.length ?? 0) > 0)) {
    const terms = [snapshot.title ?? '', ...(snapshot.roleFamilyHints ?? [])].filter(Boolean);
    const context = [snapshot.organisation, snapshot.sector, snapshot.title].filter(
      (v): v is string => Boolean(v),
    );
    const expanded = expandDomainTerms(domainPack, terms, context);

    for (const term of expanded) {
      const node = domainPack.roleNodes.find(
        (n) => n.label.toLocaleLowerCase() === term.toLocaleLowerCase(),
      );
      if (!node) continue;
      const edge = domainPack.edges.find(
        (e) => e.from === node.id && e.type === 'equivalent_title',
      );
      const isAlias = node.aliases.some((a) => a.toLocaleLowerCase() === term.toLocaleLowerCase());
      const confidence = isAlias || edge ? 0.6 : 0.8;
      const evidenceRefs: string[] = [];

      for (const cite of domainPack.evidenceCitations) {
        const evidenceId = deterministicEnrichmentId('evidence', [
          'framework',
          'posting',
          `roleFamily:${node.id}`,
          cite,
        ]);
        derivedEvidence.push({
          evidenceId: evidenceId as never,
          subjectType: 'posting',
          subjectId: `roleFamily:${node.id}`,
          fieldPath: 'roleFamilies',
          kind: 'framework',
          capturedAt: clock.producedAt,
          confidence: 1.0,
          retentionClass: 'pack_cited',
          boundedExcerpt: cite,
        });
        evidenceRefs.push(evidenceId);
      }

      roleFamilies.push({ family: node.label, confidence, evidenceRefs });
    }
  }

  return {
    derivedClaimCandidates,
    derivedEvidence,
    roleFamilies,
    requirementsInterpreted: snapshot.requirements ?? [],
    warnings,
  };
}
