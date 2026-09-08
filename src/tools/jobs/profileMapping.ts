import { canonicalProfileTermKey } from '../../jobs/profile/minimize.js';
import type { DomainPack } from '../../jobs/packs/types.js';

export interface PublicProfileInput {
  roleHints?: readonly string[];
  capabilities?: readonly string[];
}

export interface MappedProfile {
  profileInput: {
    kind: 'structured_profile';
    profile: {
      roleHints?: { kind: 'role'; packId: string; packVersion: string; termId: string }[];
      capabilities?: {
        kind: 'capability';
        packId: string;
        packVersion: string;
        termId: string;
      }[];
    };
  };
  allowedTermRefs: ReadonlySet<string>;
}

const clean = (value: string): string => value.trim().toLocaleLowerCase();

export function mapPublicProfile(input: unknown, pack: DomainPack): MappedProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('profile must be an object with pack-approved roleHints/capabilities');
  const value = input as Record<string, unknown>;
  const mapTerms = <K extends 'role' | 'capability'>(
    raw: unknown,
    kind: K,
  ): K extends 'role'
    ? { kind: 'role'; packId: string; packVersion: string; termId: string }[] | undefined
    : { kind: 'capability'; packId: string; packVersion: string; termId: string }[] | undefined => {
    if (raw === undefined) return undefined;
    if (
      !Array.isArray(raw) ||
      raw.length > 32 ||
      raw.some((v) => typeof v !== 'string' || !v.trim())
    )
      throw new Error(
        `profile.${kind === 'role' ? 'roleHints' : 'capabilities'} must be bounded strings`,
      );
    const mapped = raw.map((term) => {
      const needle = clean(term as string);
      const node =
        kind === 'role'
          ? pack.roleNodes.find((n) =>
              [n.id, n.label, ...n.aliases].some((v) => clean(v) === needle),
            )
          : undefined;
      const termId =
        node?.id ??
        (kind === 'capability'
          ? pack.capabilityVocabulary.find((v) => clean(v) === needle)
          : undefined);
      if (!termId) throw new Error(`profile term is not approved by ${pack.id}: ${String(term)}`);
      return { kind, packId: pack.id, packVersion: pack.version, termId };
    });
    return mapped as unknown as K extends 'role'
      ? { kind: 'role'; packId: string; packVersion: string; termId: string }[]
      : { kind: 'capability'; packId: string; packVersion: string; termId: string }[];
  };
  const roleHints = mapTerms(value.roleHints, 'role');
  const capabilities = mapTerms(value.capabilities, 'capability');
  if (roleHints === undefined && capabilities === undefined)
    throw new Error('profile requires roleHints or capabilities');
  const profile = {
    ...(roleHints !== undefined ? { roleHints } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
  };
  const refs = [...(roleHints ?? []), ...(capabilities ?? [])];
  return {
    profileInput: { kind: 'structured_profile', profile },
    allowedTermRefs: new Set(refs.map(canonicalProfileTermKey)),
  };
}
