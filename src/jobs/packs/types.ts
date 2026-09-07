import { z } from 'zod/v4';

const nonEmpty = z.string().trim().min(1);
const version = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    'version must be valid semantic version',
  );
const isoDate = z.iso.date();

export const PackAttributionSchema = z
  .object({
    author: nonEmpty,
    license: nonEmpty,
    source: nonEmpty.optional(),
  })
  .strict();

export const ValidationFixtureRefSchema = z
  .object({
    id: nonEmpty,
    path: nonEmpty,
    description: nonEmpty.optional(),
  })
  .strict();

export const RuleMetadataSchema = z
  .object({
    ruleId: nonEmpty,
    version,
    deterministic: z.literal(true),
    description: nonEmpty,
  })
  .strict();

export const GeographyNodeSchema = z
  .object({
    id: nonEmpty,
    name: nonEmpty,
    kind: z.enum(['country', 'state', 'region', 'city', 'postcode', 'lga', 'health_district']),
    parentId: nonEmpty.optional(),
    aliases: z.array(nonEmpty).default([]),
  })
  .strict();

export const SalaryConventionSchema = z
  .object({
    currency: nonEmpty,
    period: z.enum(['hour', 'day', 'week', 'year']),
    includesSuperannuation: z.boolean().optional(),
    notes: nonEmpty.optional(),
  })
  .strict();

export const ClassificationSchemeSchema = z
  .object({
    id: nonEmpty,
    name: nonEmpty,
    version: version.optional(),
    values: z.array(nonEmpty).default([]),
  })
  .strict();

export const LocalePackSchema = z
  .object({
    kind: z.literal('locale'),
    id: nonEmpty,
    version,
    effectiveFrom: isoDate,
    effectiveTo: isoDate.optional(),
    attribution: PackAttributionSchema,
    geography: z.array(GeographyNodeSchema),
    salaryConventions: z.array(SalaryConventionSchema),
    classificationSchemes: z.array(ClassificationSchemeSchema),
    eligibilityTerminology: z.record(nonEmpty, nonEmpty),
    sourceRegistryContributions: z.array(nonEmpty).default([]),
    normalizationRules: z.array(RuleMetadataSchema),
    evaluationFixtures: z.array(ValidationFixtureRefSchema).default([]),
  })
  .strict()
  .superRefine((pack, ctx) => {
    if (pack.effectiveTo && pack.effectiveTo < pack.effectiveFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveTo'],
        message: 'effectiveTo must not precede effectiveFrom',
      });
    }
    const geographyIds = new Set<string>();
    pack.geography.forEach((node, index) => {
      if (geographyIds.has(node.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['geography', index, 'id'],
          message: `duplicate geography node: ${node.id}`,
        });
      }
      geographyIds.add(node.id);
    });
    pack.geography.forEach((node, index) => {
      if (node.parentId && !geographyIds.has(node.parentId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['geography', index, 'parentId'],
          message: `unknown geography parent: ${node.parentId}`,
        });
      }
    });
    const classificationIds = new Set<string>();
    pack.classificationSchemes.forEach((scheme, index) => {
      if (classificationIds.has(scheme.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['classificationSchemes', index, 'id'],
          message: `duplicate classification scheme: ${scheme.id}`,
        });
      }
      classificationIds.add(scheme.id);
    });
  });

export const RoleNodeSchema = z
  .object({
    id: nonEmpty,
    label: nonEmpty,
    aliases: z.array(nonEmpty).default([]),
    capabilities: z.array(nonEmpty).default([]),
  })
  .strict();

export const RoleEdgeSchema = z
  .object({
    from: nonEmpty,
    to: nonEmpty,
    type: z.enum([
      'equivalent_title',
      'adjacent',
      'capability_transfer',
      'prerequisite',
      'false_friend',
    ]),
    evidence: z.array(nonEmpty).min(1),
    rule: RuleMetadataSchema,
  })
  .strict();

export const ExpansionGuardSchema = z
  .object({
    token: nonEmpty,
    requiresContext: z.array(nonEmpty).min(1),
  })
  .strict();

export const DomainPackSchema = z
  .object({
    kind: z.literal('domain'),
    id: nonEmpty,
    version,
    effectiveFrom: isoDate,
    effectiveTo: isoDate.optional(),
    attribution: PackAttributionSchema,
    roleNodes: z.array(RoleNodeSchema),
    edges: z.array(RoleEdgeSchema),
    capabilityVocabulary: z.array(nonEmpty),
    requirementTerminology: z.record(nonEmpty, nonEmpty),
    expansionGuards: z.array(ExpansionGuardSchema),
    evidenceCitations: z.array(nonEmpty).min(1),
    evaluationFixtures: z.array(ValidationFixtureRefSchema).default([]),
  })
  .strict()
  .superRefine((pack, ctx) => {
    if (pack.effectiveTo && pack.effectiveTo < pack.effectiveFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveTo'],
        message: 'effectiveTo must not precede effectiveFrom',
      });
    }
    const ids = new Set<string>();
    pack.roleNodes.forEach((node, index) => {
      if (ids.has(node.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['roleNodes', index, 'id'],
          message: `duplicate role node: ${node.id}`,
        });
      }
      ids.add(node.id);
    });
    pack.edges.forEach((edge, index) => {
      if (!ids.has(edge.from))
        ctx.addIssue({
          code: 'custom',
          path: ['edges', index, 'from'],
          message: `unknown role node: ${edge.from}`,
        });
      if (!ids.has(edge.to))
        ctx.addIssue({
          code: 'custom',
          path: ['edges', index, 'to'],
          message: `unknown role node: ${edge.to}`,
        });
    });
    const guarded = new Set(pack.expansionGuards.map((guard) => guard.token.toLocaleLowerCase()));
    const generic = new Set(['officer', 'analyst', 'assistant', 'support', 'clerk']);
    pack.roleNodes.forEach((node, index) => {
      [node.label, ...node.aliases].forEach((name) => {
        name
          .toLocaleLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean)
          .forEach((token) => {
            if (generic.has(token) && !guarded.has(token)) {
              ctx.addIssue({
                code: 'custom',
                path: ['roleNodes', index, 'label'],
                message: `generic token requires expansion guard: ${token}`,
              });
            }
          });
      });
    });
  });

export type PackAttribution = z.infer<typeof PackAttributionSchema>;
export type ValidationFixtureRef = z.infer<typeof ValidationFixtureRefSchema>;
export type RuleMetadata = z.infer<typeof RuleMetadataSchema>;
export type LocalePack = z.infer<typeof LocalePackSchema>;
export type RoleNode = z.infer<typeof RoleNodeSchema>;
export type RoleEdge = z.infer<typeof RoleEdgeSchema>;
export type ExpansionGuard = z.infer<typeof ExpansionGuardSchema>;
export type DomainPack = z.infer<typeof DomainPackSchema>;
export type Pack = LocalePack | DomainPack;
