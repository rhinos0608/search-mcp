import { z } from 'zod/v4';
import { EvidenceRefSchema, InstantSchema, JobPostingIdSchema } from './ids.js';

export const LifecycleStateSchema = z.enum([
  'discovered',
  'active',
  'probably_closed',
  'confirmed_closed',
  'expired',
  'superseded',
]);
export type LifecycleState = z.infer<typeof LifecycleStateSchema>;
export const LifecycleEventTypeSchema = z.enum([
  'first_seen',
  'observed',
  'verified',
  'changed',
  'source_added',
  'source_removed',
  'disappeared',
  'reposted',
  'superseded',
  'identity_merged',
  'identity_split',
]);
export const LifecycleEventSchema = z
  .object({
    eventId: z.string().min(1),
    postingId: JobPostingIdSchema,
    type: LifecycleEventTypeSchema,
    occurredAt: InstantSchema,
    fromState: LifecycleStateSchema.optional(),
    toState: LifecycleStateSchema.optional(),
    evidenceRefs: z.array(EvidenceRefSchema),
    source: z.string().min(1),
  })
  .strict()
  .superRefine((event, ctx) => {
    const toState = event.toState;
    if (event.type === 'disappeared' && toState === 'confirmed_closed') {
      ctx.addIssue({
        code: 'custom',
        path: ['toState'],
        message: 'disappearance cannot confirm closure',
      });
    }
    if (toState !== undefined) {
      const valid =
        event.fromState === undefined
          ? LifecycleStateSchema.options.some((state) => isValidLifecycleTransition(state, toState))
          : isValidLifecycleTransition(event.fromState, toState);
      if (!valid) {
        ctx.addIssue({
          code: 'custom',
          path: ['toState'],
          message: 'invalid lifecycle transition',
        });
      }
    }
  });
export function isValidLifecycleTransition(from: LifecycleState, to: LifecycleState): boolean {
  return new Set([
    'discovered:active',
    'active:probably_closed',
    'active:superseded',
    'probably_closed:confirmed_closed',
    'probably_closed:expired',
    'probably_closed:active',
    'confirmed_closed:superseded',
    'expired:superseded',
  ]).has(`${from}:${to}`);
}

export function transitionLifecycle(from: LifecycleState, to: LifecycleState): LifecycleState {
  if (!isValidLifecycleTransition(from, to))
    throw new Error(`invalid lifecycle transition: ${from} -> ${to}`);
  return to;
}
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;
