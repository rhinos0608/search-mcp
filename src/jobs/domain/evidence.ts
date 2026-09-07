import { z } from 'zod/v4';
import { EvidenceIdSchema, InstantSchema, SourceObservationIdSchema } from './ids.js';

export const EvidenceSubjectTypeSchema = z.enum([
  'posting',
  'requirement',
  'profile',
  'identity',
  'policy',
]);
export const EvidenceKindSchema = z.enum([
  'structured_field',
  'text_span',
  'attachment',
  'framework',
  'user_statement',
  'interaction',
  'source_policy',
]);
export const EvidenceSchema = z
  .object({
    evidenceId: EvidenceIdSchema,
    subjectType: EvidenceSubjectTypeSchema,
    subjectId: z.string().min(1),
    fieldPath: z.string().min(1).optional(),
    kind: EvidenceKindSchema,
    observationId: SourceObservationIdSchema.optional(),
    documentFingerprint: z.string().min(1).optional(),
    jsonPointer: z.string().min(1).optional(),
    boundedExcerpt: z.string().min(1).optional(),
    sourceUrl: z.url().optional(),
    capturedAt: InstantSchema,
    effectiveAt: InstantSchema.optional(),
    extractorVersion: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1),
    retentionClass: z.string().min(1),
  })
  .strict();
export type Evidence = z.infer<typeof EvidenceSchema>;
