/**
 * OccupationalClassifier
 *
 * Distinguishes clerical/office administration from IT/systems administration
 * by analysing job title (and falling back to description text).
 *
 * The key challenge is that "administrator" alone is ambiguous — it can mean
 * office admin OR sysadmin. We use bigram/trigram matching on the full title
 * string and only reject when a clear IT-negative phrase is detected.
 */

import type { OccupationResult } from './types.js';
import type { JobListingMvp } from '../types/job.js';

// ── Positive tokens ──────────────────────────────────────────────────────────
// These indicate clerical / office administration.

const CLERICAL_POSITIVE_TOKENS: readonly string[] = [
  'admin assistant',
  'administrative assistant',
  'office admin',
  'office administrator',
  'clerical',
  'clerical assistant',
  'clerical officer',
  'clerical worker',
  'reception',
  'receptionist',
  'data entry',
  'data entry clerk',
  'data entry officer',
  'office coordinator',
  'office co-ordinator',
  'executive assistant',
  'personal assistant',
  'secretary',
  'secretarial',
  'office manager',
  'front desk',
  'front office',
  'administration officer',
  'administration assistant',
  'admin officer',
  'admin clerk',
  'admin support',
  'office support',
  'general admin',
  'administration clerk',
  'records clerk',
  'filing clerk',
  'mail room',
  'office junior',
  'junior admin',
];

// ── Negative tokens ──────────────────────────────────────────────────────────
// These indicate IT / systems administration.

const IT_NEGATIVE_TOKENS: readonly string[] = [
  'system administrator',
  'systems administrator',
  'sysadmin',
  'system admin',
  'systems admin',
  'network administrator',
  'network admin',
  'database administrator',
  'database admin',
  'dba',
  'it administrator',
  'it admin',
  'it support',
  'technical support',
  'tech support',
  'desktop support',
  'help desk',
  'helpdesk',
  'network engineer',
  'systems engineer',
  'it specialist',
  'cloud engineer',
  'devops',
  'saas administrator',
  'saas admin',
  'infrastructure admin',
  'infrastructure administrator',
  'backup administrator',
  'backup admin',
  'gis administrator',
  'gis admin',
  'security administrator',
  'security admin',
  'linux administrator',
  'linux admin',
  'windows administrator',
  'windows admin',
  'server administrator',
  'server admin',
  'exchange administrator',
  'microsoft admin',
  'azure admin',
  'aws admin',
  'aws administrator',
  'cloud administrator',
  'storage administrator',
  'vmware administrator',
  'virtualization administrator',
  'active directory',
];

// ── Description-level scan signals ───────────────────────────────────────────

const IT_DESCRIPTION_SIGNALS: readonly RegExp[] = [
  /\b(?:active\s*directory|ad\s+domain|group\s+policy|gpo)\b/i,
  /\b(?:server|linux|windows\s+server|unix)\s+(?:administration|management|maintenance)\b/i,
  /\b(?:troubleshoot|troubleshooting|escalation|ticket(?:ing)?\s+system)\b/i,
  /\b(?:network|firewall|router|switch|vpn|cidr|subnet)\b/i,
  /\b(?:database|sql|oracle|mysql|postgresql|mongodb)\s+(?:admin|administrator|management|backup)\b/i,
  /\b(?:cloud|aws|azure|gcp|kubernetes|docker|container)\b/i,
  /\b(?:backup|restore|disaster\s+recovery|replication|failover)\s/i,
  /\b(?:maintain\s+server|maintain\s+network|maintain\s+infrastructure)\b/i,
  /\b(?:vmware|hyper-v|virtualbox|virtualization|vsphere)\b/i,
  /\b(?:scripting|powershell|bash|python|ansible|terraform|puppet|chef)\b/i,
  /\b(?:monitoring|nagios|zabbix|prometheus|grafana|splunk)\b/i,
  /\b(?:certificate|cissp|ccna|mcse|comptia|itil)\b/i,
  /\b(?:patch|security|vulnerability|audit|compliance)\s+(?:management|admin)?\s/i,
  /\b(?:software\s+installation|hardware\s+setup|peripheral)\b/i,
  /\b(?:azure\s+ad|entra\s+id|sso|oauth|saml|ldap)\b/i,
  /\b(?:exchange|sharepoint|teams admin|m365|office365)\s/i,
];

const CLERICAL_DESCRIPTION_SIGNALS: readonly RegExp[] = [
  /\b(?:schedule|calendar|appointment|meeting|booking)\b/i,
  /\b(?:correspondence|letter|memo|email|inbox|filing)\b/i,
  /\b(?:invoice|purchase\s+order|expense|budget|account(?:s)?\s+payable|receivable)\b/i,
  /\b(?:greet|welcome|visitor|client\s+facing|phone\s+calls|customer\s+service)\b/i,
  /\b(?:typing|proofread|document\s+preparation|spreadsheet|report\s+generation)\b/i,
  /\b(?:stationery|supply\s+order|inventory|asset\s+register)\b/i,
  /\b(?:minute\s+taking|agenda|board\s+paper|submission)\b/i,
  /\b(?:reception|switchboard|operator)\b/i,
  /\b(?:travel\s+arrangement|accommodation|itinerary)\b/i,
  /\b(?:database\s+entry|record\s+keeping|data\s+management)\b/i,
  /\b(?:microsoft\s+office|word\s+processing|excel|outlook|powerpoint)\b/i,
  /\b(?:staff|employee|onboarding|induction|training|payroll)\b/i,
  /\b(?:event\s+coordination|function|conference|workshop)\s+organisation\b/i,
];

// ── Token matching utilities ─────────────────────────────────────────────────

/**
 * Check if a title contains any of the given multi-word tokens.
 * Uses case-insensitive substring matching on the lowercased title.
 */
function hasAnyToken(title: string, tokens: readonly string[]): boolean {
  const lower = title.toLowerCase();
  return tokens.some((token) => lower.includes(token));
}

// ── Main classifier ──────────────────────────────────────────────────────────

/**
 * Classify a job listing's occupation as clerical admin, IT admin, other admin,
 * or unrelated.
 *
 * Strategy:
 * 1. Scan the title for IT-negative tokens first (these are more specific).
 * 2. If no IT match, scan for clerical-positive tokens.
 * 3. If title is ambiguous, scan the extracted description text for signals.
 * 4. "Administrator" alone without context is treated as uncertain.
 */
export function classifyOccupation(listing: JobListingMvp): OccupationResult {
  const title = listing.title;
  const description = listing.extractedText || '';

  // ── Phase 1: Title scan ────────────────────────────────────────────────
  const titleLower = title.toLowerCase();

  // Check IT-negative tokens first (higher specificity)
  if (hasAnyToken(title, IT_NEGATIVE_TOKENS)) {
    return {
      passed: false,
      classification: 'it_admin',
      confidence: 0.9,
      reasons: [`Title matches IT admin pattern: "${title}"`],
    };
  }

  // Check clerical-positive tokens
  if (hasAnyToken(title, CLERICAL_POSITIVE_TOKENS)) {
    return {
      passed: true,
      classification: 'clerical_admin',
      confidence: 0.85,
      reasons: [`Title matches clerical admin pattern: "${title}"`],
    };
  }

  // ── Phase 2: Single-word "admin" / "administrator" heuristic ───────────
  // "admin" alone or "administrator" alone is ambiguous.
  const hasAdmin = /\badmin\b/i.test(titleLower);
  const hasAdministrator = /\badministrator\b/i.test(titleLower);

  if (hasAdministrator && !hasAdmin) {
    // "Administrator" alone — check description for disambiguation
    const descriptionLower = description.toLowerCase();
    const itSignalCount = countRegexMatches(descriptionLower, IT_DESCRIPTION_SIGNALS);
    const clericalSignalCount = countRegexMatches(descriptionLower, CLERICAL_DESCRIPTION_SIGNALS);

    if (itSignalCount > clericalSignalCount && itSignalCount >= 2) {
      return {
        passed: false,
        classification: 'it_admin',
        confidence: 0.7,
        reasons: [
          `Title "${title}" ambiguous but description has ${String(itSignalCount)} IT signals vs ${String(clericalSignalCount)} clerical signals`,
        ],
      };
    }

    if (clericalSignalCount > itSignalCount && clericalSignalCount >= 2) {
      return {
        passed: true,
        classification: 'clerical_admin',
        confidence: 0.7,
        reasons: [
          `Title "${title}" ambiguous but description has ${String(clericalSignalCount)} clerical signals vs ${String(itSignalCount)} IT signals`,
        ],
      };
    }

    // Uncertain — allow through with reduced confidence
    return {
      passed: true,
      classification: 'other_admin',
      confidence: 0.4,
      reasons: [
        `Title "${title}" has "Administrator" without clear clerical or IT signals — allowing through`,
      ],
    };
  }

  // ── Phase 3: Description-only scan for ambiguous titles ─────────────────
  if (hasAdmin && !hasAnyToken(title, CLERICAL_POSITIVE_TOKENS)) {
    const descriptionLower = description.toLowerCase();
    const itSignalCount = countRegexMatches(descriptionLower, IT_DESCRIPTION_SIGNALS);
    const clericalSignalCount = countRegexMatches(descriptionLower, CLERICAL_DESCRIPTION_SIGNALS);

    if (itSignalCount >= 3 && itSignalCount > clericalSignalCount * 2) {
      return {
        passed: false,
        classification: 'it_admin',
        confidence: 0.65,
        reasons: [
          `Title "${title}" has "admin" but description strongly suggests IT (${String(itSignalCount)} IT signals)`,
        ],
      };
    }
  }

  // ── Phase 4: Non-admin title but might still be relevant ────────────────
  // Roles like "Office Junior", "Data Entry Clerk" are clerical despite no "admin" in title.
  if (
    hasAnyToken(title, [
      'office junior',
      'data entry',
      'reception',
      'secretary',
      'front desk',
      'clerical',
      'mail room',
    ])
  ) {
    return {
      passed: true,
      classification: 'clerical_admin',
      confidence: 0.8,
      reasons: [`Title "${title}" matched clerical role pattern`],
    };
  }

  // ── Default: Not recognisably admin — let through, classifier abstains ──
  return {
    passed: true,
    classification: 'unrelated',
    confidence: 0.2,
    reasons: [`Title "${title}" does not match admin patterns — allowing through`],
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function countRegexMatches(text: string, patterns: readonly RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      count++;
    }
  }
  return count;
}
