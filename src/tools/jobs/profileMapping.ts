import { z } from 'zod/v4';
import { canonicalProfileTermKey } from '../../jobs/profile/minimize.js';
import type { DomainPack } from '../../jobs/packs/types.js';

export const publicProfileSchema = z
  .object({
    roleHints: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
    capabilities: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
  })
  .strict()
  .refine((value) => value.roleHints !== undefined || value.capabilities !== undefined, {
    message: 'profile requires roleHints or capabilities',
  });

export type PublicProfileInput = z.infer<typeof publicProfileSchema>;

export type MappedProfileTerm =
  | { kind: 'role'; packId: string; packVersion: string; termId: string }
  | { kind: 'capability'; packId: string; packVersion: string; termId: string };

export interface MappedProfile {
  profileInput: {
    kind: 'structured_profile';
    profile: {
      roleHints?: MappedProfileTerm[];
      capabilities?: MappedProfileTerm[];
    };
  };
  allowedTermRefs: ReadonlySet<string>;
}

const clean = (value: string): string => value.trim().toLocaleLowerCase('en-US');

export function mapPublicProfile(input: unknown, pack: DomainPack): MappedProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('profile must be an object with pack-approved roleHints/capabilities');
  const value = input as Record<string, unknown>;
  const mapTerms = (raw: unknown, kind: 'role' | 'capability'): MappedProfileTerm[] | undefined => {
    if (raw === undefined) return undefined;
    if (
      !Array.isArray(raw) ||
      raw.length > 32 ||
      raw.some((v) => typeof v !== 'string' || !v.trim())
    )
      throw new Error(
        `profile.${kind === 'role' ? 'roleHints' : 'capabilities'} must be bounded strings`,
      );
    return raw.map((term): MappedProfileTerm => {
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
