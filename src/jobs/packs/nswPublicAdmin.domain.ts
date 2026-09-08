/**
 * NSW public-administration domain pack (Checkpoint B capability).
 *
 * Versioned, evidence-cited role intelligence across 12 families:
 * regulatory/compliance, intelligence/investigations/integrity,
 * analyst/research, courts/registry, public admin, health admin,
 * university/research admin, local government, NFP/disability/service ops,
 * general admin/ops, project/program support, plus records support.
 * Generic core stays assumption-free; applies ONLY when explicitly selected.
 */

import type { DomainPack } from './types.js';
import { freeze } from './freeze.js';

const RULE = (ruleId: string, description: string) => ({
  ruleId,
  version: '1.0.0',
  deterministic: true as const,
  description,
});

interface Node {
  id: string;
  label: string;
  aliases: string[];
  capabilities: string[];
}

const NODES: Node[] = [
  {
    id: 'regulatory-officer',
    label: 'Regulatory Officer',
    aliases: ['compliance officer', 'regulatory affairs officer'],
    capabilities: ['compliance', 'investigation', 'enforcement', 'assessment'],
  },
  {
    id: 'intelligence-officer',
    label: 'Intelligence Officer',
    aliases: ['intelligence analyst'],
    capabilities: ['intelligence', 'analysis', 'investigation', 'reporting'],
  },
  {
    id: 'investigations-officer',
    label: 'Investigations Officer',
    aliases: ['investigator', 'inquiries officer'],
    capabilities: ['investigation', 'evidence', 'interview', 'reporting'],
  },
  {
    id: 'integrity-officer',
    label: 'Integrity Officer',
    aliases: ['integrity analyst', 'probity officer'],
    capabilities: ['integrity', 'assurance', 'review', 'reporting'],
  },
  {
    id: 'policy-analyst',
    label: 'Policy Analyst',
    aliases: ['policy officer', 'research analyst'],
    capabilities: ['research', 'analysis', 'briefing', 'consultation'],
  },
  {
    id: 'research-officer',
    label: 'Research Officer',
    aliases: ['researcher', 'research assistant'],
    capabilities: ['research', 'data', 'analysis', 'reporting'],
  },
  {
    id: 'court-registry-officer',
    label: 'Court Registry Officer',
    aliases: ['registry officer', 'court officer', 'registrar support'],
    capabilities: ['records', 'registry', 'case_management', 'customer_service'],
  },
  {
    id: 'public-admin-officer',
    label: 'Public Administration Officer',
    aliases: ['administration officer', 'public servant', 'aps officer'],
    capabilities: ['administration', 'records', 'coordination', 'customer_service'],
  },
  {
    id: 'health-admin-officer',
    label: 'Health Administration Officer',
    aliases: ['health admin', 'hospital administrator', 'health district officer'],
    capabilities: ['health_admin', 'rostering', 'records', 'coordination'],
  },
  {
    id: 'university-admin-officer',
    label: 'University Administration Officer',
    aliases: ['faculty officer', 'research administrator', 'student services officer'],
    capabilities: ['student_services', 'research_admin', 'records', 'coordination'],
  },
  {
    id: 'local-government-officer',
    label: 'Local Government Officer',
    aliases: ['council officer', 'lga officer'],
    capabilities: ['community', 'permits', 'records', 'customer_service'],
  },
  {
    id: 'service-operations-officer',
    label: 'Service Operations Officer',
    aliases: ['disability support coordinator', 'nfp program officer', 'service delivery officer'],
    capabilities: ['service_delivery', 'case_management', 'rostering', 'support'],
  },
  {
    id: 'project-support-officer',
    label: 'Project Support Officer',
    aliases: ['project officer', 'program support officer'],
    capabilities: ['project_support', 'reporting', 'coordination', 'governance'],
  },
  {
    id: 'general-admin-officer',
    label: 'General Administration Officer',
    aliases: ['admin assistant', 'operations assistant', 'office coordinator'],
    capabilities: ['administration', 'scheduling', 'records', 'support'],
  },
];

const EDGE = (
  from: string,
  to: string,
  type: 'equivalent_title' | 'adjacent' | 'capability_transfer' | 'prerequisite' | 'false_friend',
  evidence: string,
  ruleId: string,
) => ({
  from,
  to,
  type,
  evidence: [evidence],
  rule: RULE(ruleId, `${from} ${type} ${to}`),
});

export const NSW_PUBLIC_ADMIN_DOMAIN_PACK: DomainPack = freeze({
  kind: 'domain',
  id: 'nsw-public-admin',
  version: '1.0.0',
  effectiveFrom: '2026-01-01',
  attribution: {
    author: 'search-mcp jobs subsystem',
    license: 'MIT',
    source: 'docs/jobs/adr/ADR-004-core-and-packs.md',
  },
  roleNodes: NODES.map((n) => ({
    id: n.id,
    label: n.label,
    aliases: n.aliases,
    capabilities: n.capabilities,
  })),
  edges: [
    // Regulatory/compliance cluster
    EDGE(
      'regulatory-officer',
      'integrity-officer',
      'prerequisite',
      'fixture:reg-integrity',
      'edge-6',
    ),
    EDGE(
      'regulatory-officer',
      'public-admin-officer',
      'capability_transfer',
      'fixture:reg-admin',
      'edge-7',
    ),
    // Intelligence/investigations/integrity cluster
    EDGE(
      'intelligence-officer',
      'investigations-officer',
      'adjacent',
      'fixture:intel-invest',
      'edge-1',
    ),
    EDGE(
      'investigations-officer',
      'integrity-officer',
      'capability_transfer',
      'fixture:invest-integrity',
      'edge-2',
    ),
    EDGE(
      'intelligence-officer',
      'policy-analyst',
      'capability_transfer',
      'fixture:intel-policy',
      'edge-8',
    ),
    // Analyst/research cluster
    EDGE('policy-analyst', 'research-officer', 'adjacent', 'fixture:policy-research', 'edge-3'),
    EDGE(
      'research-officer',
      'university-admin-officer',
      'capability_transfer',
      'fixture:research-uniadmin',
      'edge-9',
    ),
    // Courts/registry cluster
    EDGE(
      'court-registry-officer',
      'public-admin-officer',
      'capability_transfer',
      'fixture:registry-admin',
      'edge-4',
    ),
    EDGE(
      'court-registry-officer',
      'local-government-officer',
      'capability_transfer',
      'fixture:registry-lga',
      'edge-10',
    ),
    // Health admin cluster
    EDGE(
      'health-admin-officer',
      'public-admin-officer',
      'adjacent',
      'fixture:health-admin',
      'edge-11',
    ),
    EDGE(
      'health-admin-officer',
      'service-operations-officer',
      'capability_transfer',
      'fixture:health-service',
      'edge-12',
    ),
    // University/research admin cluster
    EDGE(
      'university-admin-officer',
      'public-admin-officer',
      'adjacent',
      'fixture:uniadmin-admin',
      'edge-13',
    ),
    // Local government cluster
    EDGE(
      'local-government-officer',
      'public-admin-officer',
      'adjacent',
      'fixture:lga-admin',
      'edge-14',
    ),
    EDGE(
      'local-government-officer',
      'service-operations-officer',
      'capability_transfer',
      'fixture:lga-service',
      'edge-15',
    ),
    // NFP/disability/service ops cluster
    EDGE(
      'service-operations-officer',
      'general-admin-officer',
      'capability_transfer',
      'fixture:service-admin',
      'edge-16',
    ),
    // General admin/ops + project/program support cluster
    EDGE(
      'project-support-officer',
      'general-admin-officer',
      'adjacent',
      'fixture:project-admin',
      'edge-5',
    ),
    EDGE(
      'project-support-officer',
      'public-admin-officer',
      'capability_transfer',
      'fixture:project-pubadmin',
      'edge-17',
    ),
    // Records support is a shared capability, never an equivalence claim:
    // general-admin links to court-registry via capability_transfer only.
    EDGE(
      'general-admin-officer',
      'court-registry-officer',
      'capability_transfer',
      'fixture:admin-registry',
      'edge-18',
    ),
  ],
  capabilityVocabulary: [...new Set(NODES.flatMap((n) => n.capabilities))],
  requirementTerminology: {
    'working with children check': 'employment_check',
    'national police check': 'employment_check',
    'australian work rights': 'work_rights',
  },
  expansionGuards: [
    { token: 'officer', requiresContext: ['registry', 'compliance', 'intelligence', 'project'] },
    { token: 'analyst', requiresContext: ['policy', 'intelligence', 'research'] },
    { token: 'assistant', requiresContext: ['admin', 'research'] },
    { token: 'support', requiresContext: ['project', 'program', 'disability', 'service'] },
    { token: 'clerk', requiresContext: ['grade', 'nsw', 'registry'] },
  ],
  evidenceCitations: ['fixture:nsw-public-admin-v1'],
  evaluationFixtures: [{ id: 'nsw-roles-basic', path: 'fixtures/nsw/roles.json' }],
});
