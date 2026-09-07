import { z } from 'zod/v4';
import { EvidenceIdSchema as DomainEvidenceIdSchema } from '../domain/ids.js';

export const EvidenceIdSchema = DomainEvidenceIdSchema;

export const ReasoningPacketIdSchema = z
  .string()
  .regex(
    /^reasoning-packet:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'Invalid ReasoningPacketId format',
  )
  .brand<'ReasoningPacketId'>();

export const ReasoningSubmissionIdSchema = z
  .string()
  .regex(
    /^reasoning-submission:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'Invalid ReasoningSubmissionId format',
  )
  .brand<'ReasoningSubmissionId'>();

export const PacketHashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Invalid PacketHash (expected 64 hex chars)')
  .brand<'PacketHash'>();

export type ReasoningPacketId = z.infer<typeof ReasoningPacketIdSchema>;
export type ReasoningSubmissionId = z.infer<typeof ReasoningSubmissionIdSchema>;
export type PacketHash = z.infer<typeof PacketHashSchema>;
