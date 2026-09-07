import { z } from 'zod/v4';
import { SourceAdapterIdSchema } from '../domain/ids.js';
import {
  AcquisitionOperationSchema,
  AcquisitionRouteSchema,
  PolicyTargetSchema,
} from './contracts.js';

export const ADAPTER_CAPABILITY_CONTRACT_VERSION = '1.0.0' as const;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

const semver = z
  .string()
  .max(64)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  );

const boundedAdapterId = SourceAdapterIdSchema.refine((v: string) => v.length <= 256, {
  message: 'exceeds max 256',
});

export const AdapterEdgeCapabilitySchema = z
  .object({
    operation: AcquisitionOperationSchema,
    route: AcquisitionRouteSchema,
    targetKind: PolicyTargetSchema.shape.kind,
  })
  .strict();

export type AdapterEdgeCapability = z.infer<typeof AdapterEdgeCapabilitySchema>;

export const AdapterCapabilitySchema = z
  .object({
    schemaVersion: z.literal(ADAPTER_CAPABILITY_CONTRACT_VERSION),
    adapterId: boundedAdapterId,
    adapterVersion: semver,
    edges: z
      .array(AdapterEdgeCapabilitySchema)
      .min(1)
      .max(32)
      .superRefine((xs, ctx) => {
        const seen = new Set<string>();
        for (const e of xs) {
          const key = `${e.operation}|${e.route}|${e.targetKind}`;
          if (seen.has(key)) {
            ctx.addIssue({ code: 'custom', message: 'duplicate edge' });
            break;
          }
          seen.add(key);
        }
      }),
  })
  .strict()
  .transform((value) => deepFreeze(value));

export type AdapterCapability = z.infer<typeof AdapterCapabilitySchema>;
