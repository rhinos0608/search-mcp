/**
 * Shared types for the generated domain-facts registry.
 *
 * The registry is a deterministic, provenance-pinned snapshot derived from
 * external source inputs (see `docs/domain-facts-registry.md`). It is a source
 * of *facts* only:
 *
 *   - CISA dotgov-data means "this domain is registered to a US federal
 *     government organization" — an ownership fact, never a statement of truth.
 *   - ROR means "this organization is registered in ROR with these identity
 *     types" — an identity fact, never reputation or truth.
 *
 * No numeric scores or ranking weights live here. Ranking policy (which fact
 * maps to which institutional prior) is applied in `src/utils/sourceTier.ts`.
 */

/** A registered US federal government domain fact from CISA dotgov-data. */
export interface CisaFact {
  /** Normalized registered domain (ASCII punycode, no `www.`, no trailing dot). */
  domain: string;
  /** CISA domain type, e.g. `Federal - Executive`. */
  type: string;
  /** Registered organization name. */
  org: string;
  /** Suborganization name, or empty string when none. */
  suborg: string;
}

/** An active organization identity fact from ROR. */
export interface RorFact {
  /** Normalized registered domain (ASCII punycode, no `www.`, no trailing dot). */
  domain: string;
  /** ROR identifier, e.g. `https://ror.org/02g1hhc29`. */
  rorId: string;
  /** Primary organization name. */
  name: string;
  /** ROR organization types (e.g. `education`, `company`, `government`). */
  types: readonly string[];
}

/** Provenance pin for one source input. Every field is required (deterministic). */
export interface SourcePin {
  /** Stable short id used as the input cache filename. */
  id: string;
  /** Human-readable source name. */
  name: string;
  /** Retrieval URL. */
  url: string;
  /** Release identifier / date. A mutable URL alone is not a version pin. */
  version: string;
  /** SHA-256 hex of the downloaded input file (immutable pin). */
  sha256: string;
  /** SPDX or short license identifier. */
  license: string;
  /** ISO date (YYYY-MM-DD) the input was retrieved. */
  retrievedAt: string;
}

/** In-memory form of the generated registry (object representation). */
export interface DomainFactsRegistry {
  registryVersion: string;
  provenance: RegistryProvenance;
  cisa: CisaFact[];
  ror: RorFact[];
  institutionalDomains: string[];
}

/** Compact row form emitted into `registry.generated.ts`: [domain, type, org, suborg]. */
export type CisaRow = readonly [string, string, string, string];

/** Compact row form emitted into `registry.generated.ts`: [domain, rorId, name, types]. */
export type RorRow = readonly [string, string, string, readonly string[]];

/** Provenance payload embedded in the generated registry file. */
export interface RegistryProvenance {
  generatedBy: string;
  sources: readonly SourcePin[];
}

/**
 * ROR organization types that qualify for the existing institutional 0.70
 * prior/basis (`.edu` / `.ac.*` academic-domain tier in `sourceTier.ts`).
 *
 * Only genuinely research/education-relevant types are promoted. Companies,
 * funders, healthcare, archives, government, and facilities are deliberately
 * excluded so not every research participant is promoted equally; those
 * organizations still appear as facts but never receive a score/basis boost.
 */
export const INSTITUTIONAL_ROR_TYPES: ReadonlySet<string> = new Set(['education']);

/** True when at least one ROR type qualifies for the institutional prior. */
export function isInstitutionalRorTypes(types: readonly string[]): boolean {
  return types.some((t) => INSTITUTIONAL_ROR_TYPES.has(t));
}

/**
 * Score and basis for ROR education organizations, mapped to the pre-existing
 * institutional tier. These MUST stay equal to the existing `.edu` / `.ac.*`
 * tier values so no ranking weight changes (tests assert this invariant).
 */
export const INSTITUTIONAL_SCORE = 0.7;
export const INSTITUTIONAL_BASIS = 'academic domain';
