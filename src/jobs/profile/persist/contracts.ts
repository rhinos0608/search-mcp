import { z } from 'zod/v4';
import type { ProfilePreferenceInput, ProfileTermRef } from '../contracts.js';

export const PROFILE_PERSISTENCE_CONTRACT_VERSION = '1.0.0' as const;

export const LOCAL_PROFILE_ID = 'profile:default' as const;

// ---------------------------------------------------------------------------
// Branded ID types
// ---------------------------------------------------------------------------

export type ProfileId = typeof LOCAL_PROFILE_ID;

export type ProfileRevisionId = `profile-revision:${string}`;
export type ProfileFactId = `profile-fact:${string}`;
export type ProfilePreferenceId = `profile-preference:${string}`;
export type ProfileCorrectionId = `profile-correction:${string}`;
export type ProfileProvenanceId = `profile-provenance:${string}`;
export type SavedProfilePacketId = `profile-packet:${string}`;

// ---------------------------------------------------------------------------
// Zod schemas for branded IDs
// ---------------------------------------------------------------------------

const profileRevisionRe = /^profile-revision:[0-9a-f]{64}$/u;
const profileFactRe = /^profile-fact:[0-9a-f]{64}$/u;
const profilePrefRe = /^profile-preference:[0-9a-f]{64}$/u;
const profileCorrectionRe = /^profile-correction:[0-9a-f]{64}$/u;
const profileProvenanceRe = /^profile-provenance:[0-9a-f]{64}$/u;
const profilePacketRe = /^profile-packet:[0-9a-f]{64}$/u;

export const ProfileRevisionIdSchema = z
  .string()
  .regex(profileRevisionRe) as z.ZodType<ProfileRevisionId>;

export const ProfileFactIdSchema = z.string().regex(profileFactRe) as z.ZodType<ProfileFactId>;

export const ProfilePreferenceIdSchema = z
  .string()
  .regex(profilePrefRe) as z.ZodType<ProfilePreferenceId>;

export const ProfileCorrectionIdSchema = z
  .string()
  .regex(profileCorrectionRe) as z.ZodType<ProfileCorrectionId>;

export const ProfileProvenanceIdSchema = z
  .string()
  .regex(profileProvenanceRe) as z.ZodType<ProfileProvenanceId>;

export const SavedProfilePacketIdSchema = z
  .string()
  .regex(profilePacketRe) as z.ZodType<SavedProfilePacketId>;

// ---------------------------------------------------------------------------
// Correction input
// ---------------------------------------------------------------------------

export interface ProfileCorrectionInput {
  kind: 'fact' | 'preference';
  prior: ProfileTermRef | ProfilePreferenceInput;
  replacement?: ProfileTermRef | ProfilePreferenceInput;
}

export const ProfileCorrectionInputSchema = z
  .object({
    kind: z.enum(['fact', 'preference']),
    prior: z.record(z.string(), z.unknown()),
    replacement: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Save / Delete / Reset inputs
// ---------------------------------------------------------------------------

export interface SaveAdoptedProfileInput {
  election: true;
  expectedRevision: ProfileRevisionId | null;

  result: Record<string, unknown>; // validated at runtime in store
  corrections?: readonly ProfileCorrectionInput[];
  savePacket?: { election: true };
}

export const SaveAdoptedProfileInputSchema = z
  .object({
    election: z.literal(true),
    expectedRevision: z.union([ProfileRevisionIdSchema, z.null()]),
    result: z.record(z.string(), z.unknown()), // validated at runtime in store
    corrections: z.array(ProfileCorrectionInputSchema).optional(),
    savePacket: z
      .object({ election: z.literal(true) })
      .strict()
      .optional(),
  })
  .strict();

export interface DeleteAdoptedProfileInput {
  election: true;
  expectedRevision: ProfileRevisionId;
}

export const DeleteAdoptedProfileInputSchema = z
  .object({
    election: z.literal(true),
    expectedRevision: ProfileRevisionIdSchema,
  })
  .strict();

export interface ResetProfileStoreInput {
  election: true;
}

export const ResetProfileStoreInputSchema = z
  .object({
    election: z.literal(true),
  })
  .strict();

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

export type ProfileStoreErrorCode =
  | 'VALIDATION_ERROR'
  | 'REVISION_CONFLICT'
  | 'KEYCHAIN_UNAVAILABLE'
  | 'KEY_MISSING'
  | 'DATABASE_LOCKED'
  | 'STORE_INCONSISTENT'
  | 'SCHEMA_INCOMPATIBLE'
  | 'IO_ERROR';

export const ProfileStoreErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'REVISION_CONFLICT',
  'KEYCHAIN_UNAVAILABLE',
  'KEY_MISSING',
  'DATABASE_LOCKED',
  'STORE_INCONSISTENT',
  'SCHEMA_INCOMPATIBLE',
  'IO_ERROR',
]);

export class ProfileStoreError extends Error {
  readonly code: ProfileStoreErrorCode;
  constructor(code: ProfileStoreErrorCode, message: string) {
    super(message);
    this.name = 'ProfileStoreError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Database type behind DI opener (subset of better-sqlite3 Database)
// ---------------------------------------------------------------------------

export interface ProfileDatabase {
  prepare(source: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(source: string): this;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): this;
}

// ---------------------------------------------------------------------------
// DI seam interfaces
// ---------------------------------------------------------------------------

export interface ProfileKeyProvider {
  read(): Promise<Uint8Array | undefined>;
  write(key: Uint8Array): Promise<void>;
  delete(): Promise<void>;
}

export interface ProfileDatabaseOpener {
  open(databasePath: string, key: Uint8Array): ProfileDatabase;
}

export interface ProfileStoreDeps {
  databasePath: string;
  keyProvider: ProfileKeyProvider;
  databaseOpener: ProfileDatabaseOpener;
  allowedTermRefs: ReadonlySet<string>;
  now?: () => Date;
  randomKey?: () => Uint8Array;
}

// ---------------------------------------------------------------------------
// Store interface and snapshot type
// ---------------------------------------------------------------------------

export interface AdoptedProfileSnapshot {
  profileId: ProfileId;
  revisionId: ProfileRevisionId;
  adoptedAt: string;
  factIds: readonly ProfileFactId[];
  preferenceIds: readonly ProfilePreferenceId[];
  correctionIds: readonly ProfileCorrectionId[];
  packetId?: SavedProfilePacketId;
}

export interface ProfileStore {
  loadAdoptedProfile(): Promise<AdoptedProfileSnapshot | undefined>;
  saveAdoptedProfile(input: SaveAdoptedProfileInput): Promise<AdoptedProfileSnapshot>;
  deleteAdoptedProfile(input: DeleteAdoptedProfileInput): Promise<boolean>;
  resetProfileStore(input: ResetProfileStoreInput): Promise<void>;
  close(): void;
}

// Dummy export so consumers of ProfileStore can type the function
export declare function createProfileStore(deps: ProfileStoreDeps): ProfileStore;
