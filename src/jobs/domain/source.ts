import { z } from 'zod/v4';
import {
  ContentHashSchema,
  EvidenceRefSchema,
  InstantSchema,
  SourceAdapterIdSchema,
  SourceListingIdSchema,
  SourceObservationIdSchema,
} from './ids.js';

export const FetchOutcomeSchema = z.enum(['success', 'partial', 'failed', 'not_supported']);

const boundedUrl = z.url().max(8192);

// Preserve exact branded values; add local max-256 without trimming/normalization.
function withMax256<T extends z.ZodType<string>>(schema: T): T {
  return (schema as unknown as z.ZodString).refine((v: string) => v.length <= 256, {
    message: 'exceeds max 256',
  }) as unknown as T;
}

const listingIdRefined = withMax256(SourceListingIdSchema);
const observationIdRefined = withMax256(SourceObservationIdSchema);
const adapterIdRefined = withMax256(SourceAdapterIdSchema);
const evidenceRefRefined = withMax256(EvidenceRefSchema);
const hashRefined = withMax256(ContentHashSchema);

const nonEmpty256 = z.string().min(1).max(256);
const nonEmpty8192 = z.string().min(1).max(8192);
const nonEmpty128 = z.string().min(1).max(128);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function shallowPreflight(input: unknown): string | null {
  try {
    if (!input || typeof input !== 'object') return null;
    const obj = input as Record<string, unknown>;
    // evidenceRefs shallow check
    if ('evidenceRefs' in obj) {
      const ev = obj.evidenceRefs;
      if (!Array.isArray(ev)) return 'evidenceRefs must be array';
      if (ev.length > 32) return 'evidenceRefs exceeds max 32';
      if (new Set(ev as unknown[]).size !== ev.length) return 'duplicate evidenceRefs';
      for (const v of ev) {
        if (typeof v !== 'string' || v.length === 0 || v.length > 256)
          return 'evidenceRef bound violated';
      }
    }
    if ('sourceConfidence' in obj) {
      const sc = obj.sourceConfidence;
      if (sc && typeof sc === 'object' && !Array.isArray(sc)) {
        const entries = Object.entries(sc as Record<string, unknown>);
        if (entries.length > 32) return 'sourceConfidence exceeds max 32';
        for (const [k, v] of entries) {
          if (typeof k !== 'string' || k.length === 0 || k.length > 128)
            return 'sourceConfidence key bound violated';
          if (typeof v !== 'number' || v < 0 || v > 1) return 'sourceConfidence value out of range';
        }
      }
    }
    if (
      'sourceListingId' in obj &&
      typeof obj.sourceListingId === 'string' &&
      obj.sourceListingId.length > 256
    )
      return 'sourceListingId too long';
    if (
      'observationId' in obj &&
      typeof obj.observationId === 'string' &&
      obj.observationId.length > 256
    )
      return 'observationId too long';
    if ('adapterId' in obj && typeof obj.adapterId === 'string' && obj.adapterId.length > 256)
      return 'adapterId too long';
    if ('externalId' in obj && typeof obj.externalId === 'string' && obj.externalId.length > 256)
      return 'externalId too long';
    if (
      'canonicalUrl' in obj &&
      typeof obj.canonicalUrl === 'string' &&
      obj.canonicalUrl.length > 8192
    )
      return 'canonicalUrl too long';
    if ('payloadRef' in obj && typeof obj.payloadRef === 'string' && obj.payloadRef.length > 8192)
      return 'payloadRef too long';
    if ('contentHash' in obj && typeof obj.contentHash === 'string' && obj.contentHash.length > 256)
      return 'contentHash too long';
    if (
      'extractionVersion' in obj &&
      typeof obj.extractionVersion === 'string' &&
      obj.extractionVersion.length > 256
    )
      return 'extractionVersion too long';
    if (
      'adapterVersion' in obj &&
      typeof obj.adapterVersion === 'string' &&
      obj.adapterVersion.length > 256
    )
      return 'adapterVersion too long';
    return null;
  } catch {
    return 'invalid observation';
  }
}

export const SourceListingSchema = z
  .object({
    sourceListingId: listingIdRefined,
    adapterId: adapterIdRefined,
    externalId: z.string().min(1).max(256).optional(),
    canonicalUrl: boundedUrl.optional(),
    firstSeenAt: InstantSchema,
    lastSeenAt: InstantSchema,
    currentObservationId: observationIdRefined,
  })
  .strict();

export type SourceListing = z.infer<typeof SourceListingSchema>;

const evidenceRefsSchema = z
  .array(evidenceRefRefined)
  .max(32)
  .superRefine((xs, ctx) => {
    if (new Set(xs as string[]).size !== xs.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate evidenceRefs' });
    }
  });

const sourceConfidenceSchema = z
  .record(nonEmpty128, z.number().min(0).max(1))
  .superRefine((val, ctx) => {
    const keys = Object.keys(val);
    if (keys.length > 32)
      ctx.addIssue({ code: 'custom', message: 'sourceConfidence exceeds max 32' });
  });

const BaseObservation = z
  .object({
    observationId: observationIdRefined,
    sourceListingId: listingIdRefined,
    fetchedAt: InstantSchema,
    contentHash: hashRefined,
    payloadRef: nonEmpty8192.optional(),
    evidenceRefs: evidenceRefsSchema,
    extractionVersion: nonEmpty256,
    adapterVersion: nonEmpty256,
    fetchOutcome: FetchOutcomeSchema,
    sourceConfidence: sourceConfidenceSchema,
    immutable: z.literal(true),
  })
  .strict();

export const SourceObservationSchema = z
  .preprocess((input) => {
    try {
      const err = shallowPreflight(input);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- sentinel must not retain hostile input
      if (err) return { __preflightRejected: err } as unknown as never;
      return input;
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- sentinel must not retain hostile input
      return { __preflightRejected: 'invalid observation' } as unknown as never;
    }
  }, BaseObservation)
  .transform((observation) => deepFreeze(observation));

export type SourceObservation = Readonly<z.infer<typeof SourceObservationSchema>>;

/** Parse and freeze immutable observation data at runtime. */
export function createSourceObservation(input: unknown): SourceObservation {
  return SourceObservationSchema.parse(input);
}
