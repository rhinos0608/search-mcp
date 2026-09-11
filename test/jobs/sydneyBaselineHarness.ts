/**
 * Stage 0 Sydney baseline harness — synthetic capture/replay ONLY.
 *
 * Executes the REAL executeJobsSearch seam over injectable acquisition seams
 * with a deterministic clock. For every case it (1) records the indexed
 * provider boundary calls (request identity hash + response or error),
 * (2) replays the recording through a fresh pipeline execution, (3) compares
 * the two independent normalized outputs, (4) sanitizes evidence to an
 * explicit allowlist BEFORE persisting an artifact, and (5) verifies the
 * persisted artifact hash plus the code identity (git commit + dirty-state
 * content fingerprint).
 *
 * Hard limits (honest, not worked around):
 * - No live network: every provider response is a synthetic fixture. The
 *   stage-0 gate therefore reports passed=false; synthetic tests never
 *   satisfy the real frozen-baseline gate.
 * - No production changes: capture/replay is implemented entirely inside the
 *   harness via the existing injectable seams (IndexedProviderPort.search).
 * - No relevance labels, no metric deltas, no fabricated telemetry.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { canonicalJson, sha256Hex } from '../../src/jobs/evaluation/hashes.js';
import type { Sha256Hex } from '../../src/jobs/evaluation/types.js';
import { EVALUATION_CONTRACT_VERSION } from '../../src/jobs/evaluation/types.js';
import { EXTRACTION_CONTRACT_VERSION } from '../../src/jobs/extraction/contracts.js';
import { ACQUISITION_COORDINATOR_VERSION } from '../../src/jobs/acquisition/coordinator.js';
import { RETRIEVAL_CONTRACT_VERSION } from '../../src/jobs/retrieval/contracts.js';
import { ASSESSMENT_CONTRACT_VERSION } from '../../src/jobs/assessment/contracts.js';
import { executeJobsSearch, JobsSearchError } from '../../src/jobs/orchestration/search.js';
import type { JobsSearchResult } from '../../src/jobs/orchestration/searchContracts.js';
import type { IndexedProviderPort } from '../../src/jobs/acquisition/providers/ports.js';
import type { SearchResult } from '../../src/types.js';
import {
  baseDeps,
  baseIntent,
  baseRequest,
  baseSlice,
  mockPort,
  snippetRecord,
} from './seamFixtures.js';
import {
  SYDNEY_BASELINE_CASES,
  validateCaseSet,
  type SydneyBaselineCase,
} from './sydneyBaselineCases.js';

// ---------------------------------------------------------------------------
// Deterministic clock (wall + monotonic frozen for every harness run)
// ---------------------------------------------------------------------------

export const FIXED_CAPTURED_AT = '2026-01-02T00:00:00.000Z';
export const FIXED_NOW_MS = 1700000000000;
export const FIXED_MONOTONIC_MS = 1234567;
const FIXED_MONOTONIC = (): number => FIXED_MONOTONIC_MS;

const HARNESS_SCHEMA_VERSION = 'stage0-harness/1' as const;
const PROVIDER_ID = 'search-provider:brave';
const ADAPTER_ID = 'indexed-provider:brave';

const HARNESS_FILES = [
  'test/jobs/sydneyBaselineCases.ts',
  'test/jobs/sydneyBaselineHarness.ts',
  'test/jobs/sydneyBaseline.test.ts',
] as const;

const IDENTITY_MANIFESTS = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'tsconfig.json',
  'tsconfig.test.json',
] as const;

function sourceFiles(root: string, directory: string): string[] {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(root, relative));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(relative);
  }
  return files;
}

function identityFiles(root: string): string[] {
  return [
    ...sourceFiles(root, 'src/jobs'),
    ...sourceFiles(root, 'src/config'),
    ...(fs.existsSync(path.join(root, 'src/config.ts')) ? ['src/config.ts'] : []),
    ...IDENTITY_MANIFESTS.filter((file) => fs.existsSync(path.join(root, file))),
    ...HARNESS_FILES.filter((file) => fs.existsSync(path.join(root, file))),
  ].sort();
}

// ---------------------------------------------------------------------------
// Code identity: git commit + dirty-state content fingerprint
// ---------------------------------------------------------------------------

export interface SydneyBaselineMetadata {
  schemaVersion: typeof HARNESS_SCHEMA_VERSION;
  gitCommit: string;
  gitDirty: boolean;
  contentFingerprint: Sha256Hex;
  fixedCapturedAt: string;
  fixedNowMs: number;
  fixedMonotonicMs: number;
  contractVersions: Record<string, string>;
  /** No model in the loop for the deterministic seam; explicit null, not absent. */
  modelRevision: null;
  packVersions: string[];
  policyRevision: string;
  harnessFiles: Record<string, Sha256Hex>;
}

function repoRoot(): string {
  return process.cwd();
}

export const UNAVAILABLE_CODE_COMMIT = 'unavailable';

function gitInfo(root: string): { commit: string; dirty: boolean } | null {
  try {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (head.status !== 0) return null;
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    if (status.status !== 0) return null;
    const commit = head.stdout.trim();
    if (commit.length === 0) return null;
    return { commit, dirty: status.stdout.trim().length > 0 };
  } catch {
    return null;
  }
}

export function computeCodeIdentity(
  packVersions: readonly string[],
  root = repoRoot(),
): SydneyBaselineMetadata {
  const info = gitInfo(root);
  const commit = info?.commit ?? UNAVAILABLE_CODE_COMMIT;
  const dirty = info?.dirty ?? false;
  const harnessFiles: Record<string, Sha256Hex> = {};
  for (const rel of identityFiles(root)) {
    harnessFiles[rel] = sha256Hex(canonicalJson(fs.readFileSync(path.join(root, rel), 'utf8')));
  }
  const contractVersions: Record<string, string> = {
    evaluation: EVALUATION_CONTRACT_VERSION,
    extraction: EXTRACTION_CONTRACT_VERSION,
    acquisitionCoordinator: ACQUISITION_COORDINATOR_VERSION,
    retrieval: RETRIEVAL_CONTRACT_VERSION,
    assessment: ASSESSMENT_CONTRACT_VERSION,
  };
  const contentFingerprint = sha256Hex(
    canonicalJson({ commit, dirty, harnessFiles, contractVersions }),
  );
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    gitCommit: commit,
    gitDirty: dirty,
    contentFingerprint,
    fixedCapturedAt: FIXED_CAPTURED_AT,
    fixedNowMs: FIXED_NOW_MS,
    fixedMonotonicMs: FIXED_MONOTONIC_MS,
    contractVersions,
    modelRevision: null,
    packVersions: [...packVersions],
    policyRevision: 'rev-1',
    harnessFiles,
  };
}

/** Rejects code drift between the metadata's capture and the current tree. */
export function verifyCodeIdentity(metadata: SydneyBaselineMetadata): void {
  const current = computeCodeIdentity(metadata.packVersions);
  // Outside a repo (or without git) identity is explicitly unavailable.
  // Drift assertions require git on both sides; capture/replay determinism
  // (record vs replay comparison) still runs regardless.
  if (
    metadata.gitCommit === UNAVAILABLE_CODE_COMMIT ||
    current.gitCommit === UNAVAILABLE_CODE_COMMIT
  ) {
    return;
  }
  const mismatches: string[] = [];
  if (current.gitCommit !== metadata.gitCommit) mismatches.push('gitCommit');
  if (current.gitDirty !== metadata.gitDirty) mismatches.push('gitDirty');
  if (current.contentFingerprint !== metadata.contentFingerprint) {
    mismatches.push('contentFingerprint');
  }
  if (mismatches.length > 0) {
    throw new Error(
      `CODE_DRIFT: capture identity no longer matches the working tree (${mismatches.join(', ')}); re-capture the baseline`,
    );
  }
}

// ---------------------------------------------------------------------------
// Provider boundary capture/replay
// ---------------------------------------------------------------------------

export interface BoundaryCallRecord {
  providerId: string;
  argsHash: Sha256Hex;
  ok: boolean;
  response?: readonly SearchResult[];
  error?: string;
  consumedInReplay: boolean;
}

export interface BoundaryRecording {
  caseId: string;
  calls: BoundaryCallRecord[];
}

function fixtureResponse(c: SydneyBaselineCase): readonly SearchResult[] {
  return [
    snippetRecord({
      title: `Fixture posting ${c.caseId}`,
      url: `https://fixtures.test/${c.caseId}/1`,
      description: `Deterministic synthetic fixture snippet for ${c.caseId}. No live provider data.`,
      domain: 'fixtures.test',
    }),
  ];
}

export function cloneBoundaryResponse(response: readonly SearchResult[]): readonly SearchResult[] {
  return structuredClone(response);
}

function argsHashOf(input: Readonly<{ query: string; limit: number }>): Sha256Hex {
  return sha256Hex(canonicalJson(input));
}

function recordingPort(
  c: SydneyBaselineCase,
  calls: BoundaryCallRecord[],
): IndexedProviderPort {
  const base = mockPort(PROVIDER_ID, async () => []);
  return {
    ...base,
    search: async (input) => {
      const argsHash = argsHashOf(input);
      if (c.providerScenario === 'unavailable') {
        calls.push({
          providerId: PROVIDER_ID,
          argsHash,
          ok: false,
          error: 'provider unavailable (synthetic fixture)',
          consumedInReplay: false,
        });
        throw new Error('provider unavailable (synthetic fixture)');
      }
      const response = c.providerScenario === 'ok_empty' ? [] : fixtureResponse(c);
      calls.push({
        providerId: PROVIDER_ID,
        argsHash,
        ok: true,
        response: cloneBoundaryResponse(response),
        consumedInReplay: false,
      });
      return cloneBoundaryResponse(response);
    },
  };
}

function replayPort(
  c: SydneyBaselineCase,
  recording: BoundaryRecording,
  replayCalls?: BoundaryCallRecord[],
): IndexedProviderPort {
  const base = mockPort(PROVIDER_ID, async () => []);
  return {
    ...base,
    search: async (input) => {
      const argsHash = argsHashOf(input);
      const slot = recording.calls.find(
        (s) => !s.consumedInReplay && s.providerId === PROVIDER_ID && s.argsHash === argsHash,
      );
      if (slot === undefined) {
        throw new Error(
          `REPLAY_MISMATCH: no unconsumed recorded provider call for providerId=${PROVIDER_ID} argsHash=${argsHash} (case ${c.caseId})`,
        );
      }
      slot.consumedInReplay = true;
      if (replayCalls !== undefined) {
        replayCalls.push({
          providerId: slot.providerId,
          argsHash: slot.argsHash,
          ok: slot.ok,
          ...(slot.response !== undefined ? { response: slot.response } : {}),
          ...(slot.error !== undefined ? { error: slot.error } : {}),
          consumedInReplay: true,
        });
      }
      if (!slot.ok) throw new Error(slot.error ?? 'recorded provider failure');
      return cloneBoundaryResponse(slot.response ?? []);
    },
  };
}

function assertReplayComplete(recording: BoundaryRecording): void {
  const unconsumed = recording.calls.filter((s) => !s.consumedInReplay);
  if (unconsumed.length > 0) {
    throw new Error(
      `REPLAY_INCOMPLETE: ${String(unconsumed.length)} recorded provider calls were not replayed (case ${recording.caseId})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Privacy: explicit allowlist scrubbing BEFORE persistence
// ---------------------------------------------------------------------------

const CANDIDATE_ALLOWLIST = new Set([
  'candidateId',
  'evidenceState',
  'eligibility',
  'eligibilityGates',
  'utility',
  'coverage',
  'confidence',
  'groupScores',
  'retrievalMetadata',
  'flags',
  'caveats',
  'provenance',
  'sourceListingIds',
  'observationIds',
  'rank',
  'identityDecisionId',
  'identityDecisionRevision',
]);

const COVERAGE_ALLOWLIST = new Set([
  'sliceId',
  'adapterId',
  'state',
  'candidatesProduced',
  'isolated',
]);

const SAFE_WARNING = /^[a-z][a-z0-9:_-]{0,127}$/u;
export const MAX_PERSISTED_WARNINGS = 32;
export const MAX_PERSISTED_ERROR_CHARS = 256;

/**
 * Bound and sanitize a raw error string before persistence. Only printable
 * ASCII survives, truncated to MAX_PERSISTED_ERROR_CHARS. Deterministic:
 * record and replay runs project identical inputs identically.
 */
export function projectErrorMessage(message: string): string {
  return message.replace(/[^ -~]/gu, '').slice(0, MAX_PERSISTED_ERROR_CHARS);
}

export function projectWarnings(warnings: readonly string[]): {
  retained: string[];
  omittedCount: number;
  truncated: boolean;
} {
  const safe = warnings.filter((warning) => SAFE_WARNING.test(warning));
  const retained = safe.slice(0, MAX_PERSISTED_WARNINGS);
  return {
    retained,
    omittedCount: warnings.length - retained.length,
    truncated: safe.length > retained.length,
  };
}

const RETRIEVAL_METADATA_ALLOWLIST = new Set([
  'rrfRank',
  'rrfScore',
  'scoredChannelCount',
  'textBm25Score',
]);

const GROUP_SCORES_ALLOWLIST = new Set([
  'relevance',
  'candidateFit',
  'preferenceFit',
  'marketState',
  'evidenceQuality',
  'personalAdaptation',
]);

const ELIGIBILITY_GATE_ALLOWLIST = new Set(['gateId', 'status', 'reason']);

/** Nested allowlist per structured candidate field. Absent = primitives only. */
const NESTED_ALLOWLIST_BY_FIELD: Readonly<Record<string, ReadonlySet<string>>> = {
  retrievalMetadata: RETRIEVAL_METADATA_ALLOWLIST,
  groupScores: GROUP_SCORES_ALLOWLIST,
};

function pickAllowed(value: unknown, allow: ReadonlySet<string>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => pickAllowed(v, allow));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!allow.has(k)) continue;
    if (k === 'eligibilityGates' && Array.isArray(v)) {
      out[k] = v.map((gate) => pickAllowed(gate, ELIGIBILITY_GATE_ALLOWLIST));
      continue;
    }
    const nested = NESTED_ALLOWLIST_BY_FIELD[k];
    if (nested !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = pickAllowed(v, nested);
      continue;
    }
    if (Array.isArray(v)) {
      // Primitive arrays only (flags, caveats, provenance, id lists):
      // persist scalar items, drop object items with unspecified keys.
      out[k] = v.filter((item) => item === null || typeof item !== 'object');
      continue;
    }
    if (v !== null && typeof v === 'object') {
      // Structured field without an explicit nested allowlist: do not
      // persist unspecified keys. Preserve only scalar leaf values keyed
      // by the top-level allowlist entry itself is impossible, so drop.
      continue;
    }
    out[k] = v;
  }
  return out;
}

/**
 * Sanitized result projection: bounded score/eligibility/coverage fields only.
 * Posting text fields (title, organisation, description, URLs, salary text,
 * location) are never persisted — sanitization happens BEFORE any artifact
 * is written.
 */
export function scrubResult(result: JobsSearchResult): unknown {
  return {
    schemaVersion: result.schemaVersion,
    runId: result.runId,
    status: result.status,
    acquisitionStatus: result.acquisitionStatus,
    warnings: projectWarnings(result.warnings),
    eligibilitySummary: result.eligibilitySummary,
    versions: result.versions,
    candidates: result.candidates.map((c) => pickAllowed(c, CANDIDATE_ALLOWLIST)),
    coverageOutcomes: result.coverageOutcomes.map((c) => pickAllowed(c, COVERAGE_ALLOWLIST)),
  };
}

// ---------------------------------------------------------------------------
// Case execution
// ---------------------------------------------------------------------------

export interface SydneyBaselineCaseOutcome {
  caseId: string;
  cohort: SydneyBaselineCase['cohort'];
  query: string;
  providerScenario: SydneyBaselineCase['providerScenario'];
  intentConstraints: SydneyBaselineCase['intentConstraints'];
  unsupportedConstraints: SydneyBaselineCase['unsupportedConstraints'];
  expectedBehavior: SydneyBaselineCase['expectedBehavior'];
  outcome: 'completed' | 'failed';
  errorCode?: string;
  errorMessage?: string;
  /** Sanitized boundary records: no response payloads, identity hash only. */
  boundaryCalls: {
    providerId: string;
    argsHash: Sha256Hex;
    ok: boolean;
    error?: string;
    consumedInReplay: boolean;
  }[];
  boundaryFailureCount: number;
  boundaryEmptySuccessCount: number;
  scrubbedResult?: unknown;
  packVersions: string[];
}

interface CaseRunResult {
  result?: JobsSearchResult;
  errorCode?: string;
  errorMessage?: string;
}

function caseRunId(c: SydneyBaselineCase): string {
  return `sydney-stage0-${c.caseId}`;
}

function buildRequest(c: SydneyBaselineCase) {
  return baseRequest({
    intent: baseIntent({
      query: c.query,
      locations: c.intentConstraints.locations ?? [],
      workModes: c.intentConstraints.workModes ?? [],
      employmentTypes: c.intentConstraints.employmentTypes ?? [],
      compensation: c.intentConstraints.compensation ?? [],
      ...(c.intentConstraints.unknownPolicy !== undefined
        ? { unknownPolicy: c.intentConstraints.unknownPolicy }
        : {}),
      budgets: {
        requests: 2,
        pages: 2,
        bytes: 100000,
        milliseconds: 30000,
        enrichment: 0,
        reasoning: 0,
      },
    }),
    plan: [
      {
        kind: 'indexed',
        slice: baseSlice({
          runId: caseRunId(c),
          sliceId: `slice-${c.caseId}`,
          queryVariantId: `qv-${c.caseId}`,
          query: c.query,
          reason: 'stage0-sydney-baseline',
          adapterIds: [ADAPTER_ID],
        }),
        providerId: PROVIDER_ID,
        safeSearch: 'moderate',
      },
    ],
    runId: caseRunId(c),
    capturedAt: FIXED_CAPTURED_AT,
    nowMs: FIXED_NOW_MS,
    monotonicNow: FIXED_MONOTONIC,
  });
}

async function runCaseWithPort(
  c: SydneyBaselineCase,
  port: IndexedProviderPort,
): Promise<CaseRunResult> {
  try {
    const result = await executeJobsSearch(buildRequest(c), baseDeps([port]));
    return { result };
  } catch (err) {
    if (err instanceof JobsSearchError) {
      return { errorCode: err.code, errorMessage: err.message };
    }
    throw err;
  }
}

/**
 * Executes one case against the recording port: returns the in-memory
 * recording (with response payloads, for replay) plus the sanitized outcome.
 */
export async function captureRecordingForCase(
  c: SydneyBaselineCase,
): Promise<{ recording: BoundaryRecording; outcome: SydneyBaselineCaseOutcome }> {
  const calls: BoundaryCallRecord[] = [];
  const run = await runCaseWithPort(c, recordingPort(c, calls));
  return {
    recording: { caseId: c.caseId, calls: calls.map((slot) => ({ ...slot })) },
    outcome: buildOutcome(c, run, calls),
  };
}

function buildOutcome(
  c: SydneyBaselineCase,
  run: CaseRunResult,
  calls: readonly BoundaryCallRecord[],
): SydneyBaselineCaseOutcome {
  const boundaryCalls = calls.map((s) => ({
    providerId: s.providerId,
    argsHash: s.argsHash,
    ok: s.ok,
    consumedInReplay: s.consumedInReplay,
    ...(s.error !== undefined ? { error: projectErrorMessage(s.error) } : {}),
  }));
  const outcome: SydneyBaselineCaseOutcome = {
    caseId: c.caseId,
    cohort: c.cohort,
    query: c.query,
    providerScenario: c.providerScenario,
    intentConstraints: c.intentConstraints,
    unsupportedConstraints: c.unsupportedConstraints,
    expectedBehavior: c.expectedBehavior,
    outcome: run.result !== undefined ? 'completed' : 'failed',
    boundaryCalls,
    boundaryFailureCount: calls.filter((s) => !s.ok).length,
    boundaryEmptySuccessCount: calls.filter((s) => s.ok && (s.response?.length ?? 0) === 0).length,
    packVersions: run.result?.versions.packVersions ?? [],
    ...(run.result !== undefined
      ? { scrubbedResult: scrubResult(run.result) }
      : {
          ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
          ...(run.errorMessage !== undefined
            ? { errorMessage: projectErrorMessage(run.errorMessage) }
            : {}),
        }),
  };
  return outcome;
}

/**
 * Replays a recording through a fresh pipeline execution and verifies that
 * every recorded provider call was consumed with identical request identity.
 * Returns the replay outcome plus a deterministic comparison key.
 */
export async function replayCaseRun(
  c: SydneyBaselineCase,
  recording: BoundaryRecording,
): Promise<{ outcome: SydneyBaselineCaseOutcome; comparisonKey: string; calls: BoundaryCallRecord[] }> {
  if (recording.calls.length === 0) {
    throw new Error(`REPLAY_MISMATCH: recording has no provider calls (case ${c.caseId})`);
  }
  const replayCalls: BoundaryCallRecord[] = [];
  const run = await runCaseWithPort(c, replayPort(c, recording, replayCalls));
  assertReplayComplete(recording);
  const outcome = buildOutcome(c, run, replayCalls);
  return { outcome, comparisonKey: outcomeComparisonKey(outcome), calls: replayCalls };
}

function outcomeComparisonKey(o: SydneyBaselineCaseOutcome): string {
  return sha256Hex(
    canonicalJson({
      outcome: o.outcome,
      errorCode: o.errorCode ?? null,
      errorMessage: o.errorMessage ?? null,
      boundaryCalls: o.boundaryCalls.map(({ consumedInReplay: _, ...call }) => call),
      scrubbedResult: o.scrubbedResult ?? null,
    }),
  );
}

// ---------------------------------------------------------------------------
// Evidence bundle: tamper detection + persistence
// ---------------------------------------------------------------------------

export interface SydneyBaselineBundle {
  schemaVersion: typeof HARNESS_SCHEMA_VERSION;
  metadata: SydneyBaselineMetadata;
  gate: { passed: boolean; syntheticOnly: boolean; reason: string };
  cases: SydneyBaselineCaseOutcome[];
  contentHash: Sha256Hex;
}

const STAGE0_GATE_REASON =
  'Stage 0 gate NOT satisfied: these are synthetic harness fixtures only. ' +
  'The real frozen baseline requires live capture, which is blocked: direct ' +
  'government acquisition is unverified and indexed provider retention ' +
  'permission is unresolved. No live capture was run.';

export function bundleIntegrityInput(
  bundle: Omit<SydneyBaselineBundle, 'contentHash'> | SydneyBaselineBundle,
): string {
  const { contentHash: _, ...rest } = bundle as SydneyBaselineBundle;
  return canonicalJson(rest);
}

export function verifyBundleIntegrity(bundle: SydneyBaselineBundle): void {
  const { contentHash: _, ...rest } = bundle;
  const computed = sha256Hex(canonicalJson(rest));
  if (computed !== bundle.contentHash) {
    throw new Error('EVIDENCE_TAMPER: persisted evidence bundle contentHash mismatch');
  }
}

// ---------------------------------------------------------------------------
// Full harness run
// ---------------------------------------------------------------------------

export interface SydneyBaselineHarnessResult {
  bundle: SydneyBaselineBundle;
  artifactPath: string;
  artifactJson: SydneyBaselineBundle;
}

export async function runSydneyBaselineHarness(): Promise<SydneyBaselineHarnessResult> {
  validateCaseSet(SYDNEY_BASELINE_CASES);

  // Pass 1: record (real pipeline + recording port).
  const recordings = new Map<string, BoundaryRecording>();
  const outcomes: SydneyBaselineCaseOutcome[] = [];
  for (const c of SYDNEY_BASELINE_CASES) {
    const captured = await captureRecordingForCase(c);
    recordings.set(c.caseId, captured.recording);
    outcomes.push(captured.outcome);
  }

  const packVersions = outcomes.find((o) => o.outcome === 'completed')?.packVersions ?? [];
  const metadata = computeCodeIdentity(packVersions);

  // Pass 2: replay (fresh pipeline over recorded boundary responses) and
  // compare the two independent normalized executions.
  for (const c of SYDNEY_BASELINE_CASES) {
    const recording = recordings.get(c.caseId);
    if (recording === undefined) throw new Error(`REPLAY_MISMATCH: no recording for ${c.caseId}`);
    const replayed = await replayCaseRun(c, recording);
    const recorded = outcomes.find((o) => o.caseId === c.caseId);
    if (recorded === undefined) throw new Error(`HARNESS_ERROR: missing recorded outcome ${c.caseId}`);
    if (outcomeComparisonKey(recorded) !== replayed.comparisonKey) {
      throw new Error(
        `DETERMINISM_MISMATCH: record and replay normalized outputs differ for case ${c.caseId}`,
      );
    }
    for (const [index, call] of recorded.boundaryCalls.entries()) {
      const replaySlot = recording.calls[index];
      if (replaySlot !== undefined) call.consumedInReplay = replaySlot.consumedInReplay;
    }
    const replaySlots = replayed.calls;
    if (replaySlots.length !== recorded.boundaryCalls.length) {
      throw new Error(
        `DETERMINISM_MISMATCH: boundary call count differs for case ${c.caseId}`,
      );
    }
  }

  const bundle: SydneyBaselineBundle = {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    metadata,
    gate: { passed: false, syntheticOnly: true, reason: STAGE0_GATE_REASON },
    cases: outcomes,
    contentHash: '',
  };
  bundle.contentHash = sha256Hex(bundleIntegrityInput(bundle));

  // Sanitized evidence precedes persistence: the bundle is fully scrubbed and
  // hashed above; only then is it written and re-verified from disk.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sydney-stage0-'));
  const artifactPath = path.join(dir, 'bundle.json');
  fs.writeFileSync(artifactPath, canonicalJson(bundle), 'utf8');
  const reloaded = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as SydneyBaselineBundle;
  verifyBundleIntegrity(reloaded);

  return { bundle, artifactPath, artifactJson: reloaded };
}
