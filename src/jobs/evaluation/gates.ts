import { EVALUATION_CONTRACT_VERSION } from './types.js';
import type { CheckpointEvidence, GateFinding, QualityGateReport, SuiteMetrics } from './types.js';
import type { FrozenCorpus } from './types.js';

// ---------------------------------------------------------------------------
// evaluateQualityGates
// ---------------------------------------------------------------------------

export function evaluateQualityGates(input: {
  checkpoint: 'A' | 'B' | 'C' | 'D';
  corpora: readonly FrozenCorpus[];
  metrics: readonly SuiteMetrics[];
  runIntegrity: { integrityFailures: number; policyFailures: number; successRate: number };
  extras?: CheckpointEvidence;
}): QualityGateReport {
  const findings: GateFinding[] = [];

  // --- Shared baseline: always evaluated ---
  addFindingsForIntegrity(findings, input);
  const metricValues = input.metrics.flatMap((suite) => [
    suite.macro.precisionAt10,
    suite.macro.recallAt20,
    suite.macro.ndcgAt10,
    suite.macro.fixedBudgetRecall,
    ...(suite.macro.pairwiseAccuracy === undefined ? [] : [suite.macro.pairwiseAccuracy]),
    ...suite.perQuery.flatMap((query) => [
      query.precisionAt10,
      query.recallAt20,
      query.ndcgAt10,
      query.fixedBudgetRecall,
      ...(query.pairwiseAccuracy === undefined ? [] : [query.pairwiseAccuracy]),
    ]),
  ]);
  findings.push({
    gateId: 'EVAL_METRICS',
    checkpoint: input.checkpoint,
    passed:
      input.metrics.length > 0 &&
      input.metrics.every((suite) => {
        const corpus = input.corpora.find((c) => c.manifest.corpusId === suite.corpusId);
        const testQueries = corpus?.queries.filter((q) => q.split === 'test') ?? [];
        const testIds = new Set(testQueries.map((q) => q.queryId));
        const metricIds = suite.perQuery.map((q) => q.queryId);
        const exactCoverage =
          metricIds.length === testIds.size &&
          new Set(metricIds).size === metricIds.length &&
          metricIds.every((id) => testIds.has(id)) &&
          testQueries.every((q) => corpus?.labels.some((label) => label.queryId === q.queryId));
        return (
          suite.queryCount === testIds.size &&
          testIds.size > 0 &&
          suite.perQuery.length > 0 &&
          corpus?.manifest.status === 'frozen' &&
          suite.suiteId === corpus.manifest.suiteId &&
          suite.suiteVersion === corpus.manifest.suiteVersion &&
          suite.manifestHash === corpus.manifest.manifestHash &&
          exactCoverage
        );
      }) &&
      metricValues.length > 0 &&
      metricValues.every((value) => Number.isFinite(value) && value >= 0 && value <= 1),
    severity: 'P0',
    code: 'METRICS_BOUNDED',
    detail: 'evaluation metrics must be finite numbers in [0,1]',
  });

  // --- Checkpoint-specific gates ---
  switch (input.checkpoint) {
    case 'A':
      addCheckpointA(findings, input.corpora, input.extras);
      break;
    case 'B':
      addCheckpointB(findings, input.corpora, input.extras);
      break;
    case 'C':
      addCheckpointC(findings, input.corpora, input.extras);
      break;
    case 'D':
      addCheckpointD(findings, input.corpora, input);
      break;
  }

  const profile = input.extras?.profilePersistenceEvidence ?? {};
  const profileNonpersistent =
    profile.inactiveProfileAttestation === true &&
    profile.noProductionStoreWiring === true &&
    profile.noWriteAction === true &&
    profile.requestScopedOnly === true &&
    profile.zeroPersistence === true &&
    profile.reusableHandle === false;
  const gateApplicability: Record<string, 'applicable' | 'not_applicable'> = {};
  for (const finding of findings) {
    gateApplicability[finding.gateId] =
      finding.gateId === 'D.retention_encryption' && profileNonpersistent
        ? 'not_applicable'
        : 'applicable';
  }

  // Applicability is decided before aggregate gates: verified inactive retention is
  // non-blocking, but its finding remains false so evidence never appears as a pass.
  const noOpen = findings.find((f) => f.gateId === 'D.no_open_p0p1');
  if (noOpen) {
    const priorP0P1 = findings.filter(
      (f) => (f.severity === 'P0' || f.severity === 'P1') && f !== noOpen,
    );
    noOpen.passed = priorP0P1.every(
      (f) => gateApplicability[f.gateId] === 'not_applicable' || f.passed,
    );
    noOpen.detail = noOpen.passed
      ? 'zero unresolved P0/P1 findings'
      : 'unresolved P0/P1 findings detected';
  }

  // Missing applicability remains applicable (fail closed).
  const allPassed = findings.every((f) => {
    if (gateApplicability[f.gateId] === 'not_applicable') return true;
    return f.passed || (input.checkpoint !== 'D' && f.severity === 'P2');
  });

  return {
    schemaVersion: EVALUATION_CONTRACT_VERSION,
    checkpoint: input.checkpoint,
    passed: allPassed,
    gateApplicability,
    findings,
    suiteMetrics: [...input.metrics],
    integrityFailures: input.runIntegrity.integrityFailures,
    policyFailures: input.runIntegrity.policyFailures,
    successRate: input.runIntegrity.successRate,
  };
}

// ---------------------------------------------------------------------------
// Checkpoint A — Waves 0–4
// ---------------------------------------------------------------------------

function addCheckpointA(
  findings: GateFinding[],
  corpora: readonly FrozenCorpus[],
  extras?: CheckpointEvidence,
): void {
  // A.telemetry_privacy: P0 — REQUIRED evidence. Fail when fixtures absent
  // or when any whole fixture object carries raw query/URL/path/identifier
  // or error payload material (root-level rawQuery cannot hide outside .payload).
  const telemetryFixtures = extras?.telemetryFixtures;
  const telemetryPresent = Array.isArray(telemetryFixtures) && telemetryFixtures.length > 0;
  const telemetryClean = telemetryPresent && telemetryFixtures.every((f) => !telemetryLeaks(f));
  const telemetryPass: boolean = telemetryClean;
  findings.push({
    gateId: 'A.telemetry_privacy',
    checkpoint: 'A',
    passed: telemetryPass,
    severity: 'P0',
    code: 'TELEMETRY_PRIVACY',
    detail: !telemetryPresent
      ? 'telemetry evidence missing: cannot verify privacy'
      : telemetryPass
        ? 'process-telemetry fixtures contain no raw query, URL, path, identifier, error payload'
        : 'telemetry fixture leaks raw query/URL/path/identifier/error payload',
  });

  // A.immutable_observations: P0 — REQUIRED evidence. Every frozen doc
  // (manifest documents plus explicit extras) must carry immutable: true.
  const docs = [...corpora.flatMap((c) => c.documents), ...(extras?.frozenDocuments ?? [])];
  const immutablePass: boolean = docs.length > 0 && docs.every((d) => d.immutable === true);
  findings.push({
    gateId: 'A.immutable_observations',
    checkpoint: 'A',
    passed: immutablePass,
    severity: 'P0',
    code: 'IMMUTABLE_OBSERVATIONS',
    detail: immutablePass
      ? 'frozen observations have immutable: true'
      : 'frozen document without immutable: true',
  });

  // A.independent_policy: P0 — REQUIRED evidence. Every edge decision must
  // be registry-decided (decidedBy === 'policy-registry') and never
  // adapter-defined, with a non-empty state.
  const policyEdges = extras?.policyEdges;
  const policyPresent = Array.isArray(policyEdges) && policyEdges.length > 0;
  const policyPass =
    policyPresent &&
    policyEdges.every(
      (e: NonNullable<CheckpointEvidence['policyEdges']>[number]) =>
        e.decidedBy === 'policy-registry' &&
        e.adapterDefined !== true &&
        typeof e.state === 'string' &&
        e.state.length > 0,
    );
  findings.push({
    gateId: 'A.independent_policy',
    checkpoint: 'A',
    passed: policyPass,
    severity: 'P0',
    code: 'INDEPENDENT_POLICY',
    detail: !policyPresent
      ? 'policy edge evidence missing: cannot verify adapter independence'
      : policyPass
        ? 'policy decisions exist per edge; adapters do not define policy'
        : 'edge decision adapter-defined or missing registry provenance',
  });

  // A.manual_import: P1 — REQUIRED evidence. Every run must be url_only
  // with fetch not permitted, status content_required, and zero fetch.
  const manualRuns = extras?.manualImportRuns;
  const manualPresent = Array.isArray(manualRuns) && manualRuns.length > 0;
  const manualPass =
    manualPresent &&
    manualRuns.every(
      (r: NonNullable<CheckpointEvidence['manualImportRuns']>[number]) =>
        r.contentKind === 'url_only' &&
        r.fetchPermitted === false &&
        r.status === 'content_required' &&
        r.fetched !== true,
    );
  findings.push({
    gateId: 'A.manual_import',
    checkpoint: 'A',
    passed: manualPass,
    severity: 'P1',
    code: 'MANUAL_IMPORT',
    detail: !manualPresent
      ? 'manual-import evidence missing: cannot verify content_required'
      : manualPass
        ? 'manual URL-only without fetch permission yields content_required'
        : 'manual run fetched or did not yield content_required',
  });

  // A.multi_source_records: P1 — REQUIRED evidence. At least one posting
  // must carry >= 2 distinct sourceListingIds (multi-source proven, not
  // merely representable).
  const postings = extras?.multiSourcePostings;
  const postingsPresent = Array.isArray(postings) && postings.length > 0;
  const multiPass =
    postingsPresent &&
    postings.some(
      (p: NonNullable<CheckpointEvidence['multiSourcePostings']>[number]) =>
        Array.isArray(p.sourceListingIds) &&
        p.sourceListingIds.length >= 2 &&
        p.sourceListingIds.every(
          (id): id is string => typeof id === 'string' && id.trim().length > 0,
        ) &&
        new Set(p.sourceListingIds).size >= 2,
    );
  findings.push({
    gateId: 'A.multi_source_records',
    checkpoint: 'A',
    passed: multiPass,
    severity: 'P1',
    code: 'MULTI_SOURCE_RECORDS',
    detail: !postingsPresent
      ? 'posting evidence missing: cannot verify multi-source records'
      : multiPass
        ? 'same posting can carry multiple sourceListingIds'
        : 'no posting carries multiple distinct sourceListingIds',
  });

  // A.generic_core: P2. Locale-defaults evidence is informational: an empty
  // list means no defaults asserted (pass); a required-authority entry fails.
  // Stays P2 so absent evidence never blocks on a non-required gate.
  const localeDefaults = extras?.localeDefaults ?? [];
  const genericPass = localeDefaults.every((d) => d.requiredAuthority !== true);
  findings.push({
    gateId: 'A.generic_core',
    checkpoint: 'A',
    passed: genericPass,
    severity: 'P2',
    code: 'GENERIC_CORE',
    detail: genericPass
      ? 'generic suite loads without NSW pack as required authority'
      : 'locale default asserts required authority',
  });
}

// Telemetry leak scan: a suspect key (raw query/URL/path/identifier/error
// material) fails the fixture only when it carries material — a non-empty
// string, array, or object. Bare `payload` is a structural contract key, not
// a leak signal (its value is still scanned recursively). Aggregate scalars
// such as errorCount: 3 carry no raw material and pass.
function telemetryLeaks(payload: unknown): boolean {
  const suspectKey = /query|url|path|identifier|error|raw/i;
  const hasMaterial = (value: unknown): boolean => {
    if (typeof value === 'string') return value.length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
    return false;
  };
  const seen = new Set<unknown>();
  const walk = (value: unknown): boolean => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return false;
    if (typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(walk);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (suspectKey.test(k) && hasMaterial(v)) return true;
      if (walk(v)) return true;
    }
    return false;
  };
  return walk(payload);
}

// ---------------------------------------------------------------------------
// Checkpoint B — Waves 5–7
// ---------------------------------------------------------------------------

function addCheckpointB(
  findings: GateFinding[],
  corpora: readonly FrozenCorpus[],
  extras?: CheckpointEvidence,
): void {
  // B.extraction_evidence: P0 — REQUIRED list. Every observed claim carries
  // evidence refs; absent evidence fails (never vacuous).
  const claims = extras?.extractionClaims;
  const claimsPresent = Array.isArray(claims) && claims.length > 0;
  const extractionEvidencePass =
    claimsPresent &&
    claims.every(
      (c: { hasEvidenceRefs?: unknown; origin?: unknown }) =>
        c.hasEvidenceRefs === true && c.origin !== 'model_derived',
    );
  void corpora;
  findings.push({
    gateId: 'B.extraction_evidence',
    checkpoint: 'B',
    passed: extractionEvidencePass,
    severity: 'P0',
    code: 'EXTRACTION_EVIDENCE',
    detail: !claimsPresent
      ? 'extraction claim evidence missing: cannot verify evidence refs'
      : extractionEvidencePass
        ? 'every observed claim in extraction suite has evidenceRefs.length >= 1'
        : 'observed claim without evidence refs or model-derived origin',
  });

  // B.queryable_fields: P1 — REQUIRED list. All five relational projections
  // (title/org/location/salary/lifecycle) must report present.
  const rows = extras?.projectionRows;
  const rowsPresent = Array.isArray(rows) && rows.length > 0;
  const need = new Set(['title', 'organisation', 'location', 'salary', 'lifecycle']);
  const seen = new Set(
    (rowsPresent ? rows : [])
      .filter((r: { present?: unknown }) => r.present === true)
      .map((r: { projection?: unknown }) => String(r.projection)),
  );
  const queryablePass = rowsPresent && [...need].every((p) => seen.has(p));
  findings.push({
    gateId: 'B.queryable_fields',
    checkpoint: 'B',
    passed: queryablePass,
    severity: 'P1',
    code: 'QUERYABLE_FIELDS',
    detail: !rowsPresent
      ? 'projection evidence missing: cannot verify queryable fields'
      : queryablePass
        ? 'relational projections present for title/org/location/salary/lifecycle'
        : 'relational projection missing for a required field',
  });

  // B.conflicts: P1 — REQUIRED list. Every case must stay conflicting with
  // alternatives preserved.
  const conflicts = extras?.conflictCases;
  const conflictsPresent = Array.isArray(conflicts) && conflicts.length > 0;
  const conflictsPass =
    conflictsPresent &&
    conflicts.every(
      (c: { state?: unknown; alternativesPreserved?: unknown }) =>
        c.state === 'conflicting' && c.alternativesPreserved === true,
    );
  findings.push({
    gateId: 'B.conflicts',
    checkpoint: 'B',
    passed: conflictsPass,
    severity: 'P1',
    code: 'CONFLICTS',
    detail: !conflictsPresent
      ? 'conflict evidence missing: cannot verify conflict preservation'
      : conflictsPass
        ? 'conflicting claims stay state: conflicting with alternatives preserved'
        : 'conflict collapsed or alternatives dropped',
  });

  // B.identity_merge_split: P0 — REQUIRED list. Org+title-only probes must
  // not merge; probes with stronger evidence may merge.
  const probes = extras?.identityProbes;
  const probesPresent = Array.isArray(probes) && probes.length > 0;
  const mergePass =
    probesPresent &&
    probes.every((p: { scenario?: unknown; merged?: unknown }) =>
      p.scenario === 'org_title_only' ? p.merged !== true : typeof p.merged === 'boolean',
    ) &&
    probes.some(
      (p: { scenario?: unknown; merged?: unknown }) =>
        p.scenario === 'org_title_only' && p.merged === false,
    );
  findings.push({
    gateId: 'B.identity_merge_split',
    checkpoint: 'B',
    passed: mergePass,
    severity: 'P0',
    code: 'IDENTITY_MERGE_SPLIT',
    detail: !probesPresent
      ? 'identity probe evidence missing: cannot verify merge/split'
      : mergePass
        ? 'same company+title alone does not merge'
        : 'org+title-only probe merged or missing',
  });

  // B.lifecycle: P0 — REQUIRED list. disappeared→confirmed_closed must be
  // disallowed; at least one disallowed probe required (never vacuous).
  const lc = extras?.lifecycleProbes;
  const lcPresent = Array.isArray(lc) && lc.length > 0;
  const lcPass =
    lcPresent &&
    lc.every((p: { from?: unknown; to?: unknown; allowed?: unknown }) =>
      p.from === 'disappeared' && p.to === 'confirmed_closed'
        ? p.allowed === false
        : typeof p.allowed === 'boolean',
    ) &&
    lc.some(
      (p: { from?: unknown; to?: unknown; allowed?: unknown }) =>
        p.from === 'disappeared' && p.to === 'confirmed_closed' && p.allowed === false,
    );
  findings.push({
    gateId: 'B.lifecycle',
    checkpoint: 'B',
    passed: lcPass,
    severity: 'P0',
    code: 'LIFECYCLE',
    detail: !lcPresent
      ? 'lifecycle probe evidence missing: cannot verify transition guard'
      : lcPass
        ? 'disappeared cannot transition to confirmed_closed'
        : 'disappeared→confirmed_closed allowed or unprobed',
  });
}

// ---------------------------------------------------------------------------
// Checkpoint C — Waves 8–10
// ---------------------------------------------------------------------------

function addCheckpointC(
  findings: GateFinding[],
  _corpora: readonly FrozenCorpus[],
  extras?: CheckpointEvidence,
): void {
  void _corpora;
  // C.fixed_budget_recall: P0 — REQUIRED list. Recall snapshot must be
  // computed at the declared budget (finite, non-percentile claim).
  const snaps = extras?.recallSnapshots;
  const snapsPresent = Array.isArray(snaps) && snaps.length > 0;
  const recallPass =
    snapsPresent &&
    snaps.every(
      (s: { computedAtBudget?: unknown; fixedBudgetRecall?: unknown }) =>
        s.computedAtBudget === true &&
        typeof s.fixedBudgetRecall === 'number' &&
        Number.isFinite(s.fixedBudgetRecall) &&
        s.fixedBudgetRecall >= 0 &&
        s.fixedBudgetRecall <= 1,
    );
  findings.push({
    gateId: 'C.fixed_budget_recall',
    checkpoint: 'C',
    passed: recallPass,
    severity: 'P0',
    code: 'FIXED_BUDGET_RECALL',
    detail: !snapsPresent
      ? 'recall evidence missing: cannot verify fixed-budget recall'
      : recallPass
        ? 'fixedBudgetRecall computed at declared candidate budget; not percentile'
        : 'recall snapshot not computed at declared budget',
  });

  // C.stable_bm25: P0 — REQUIRED list. Same query twice yields same score.
  const probes = extras?.bm25Probes;
  const probesPresent = Array.isArray(probes) && probes.length > 0;
  const bm25Pass =
    probesPresent &&
    probes.every(
      (p: { firstScore?: unknown; secondScore?: unknown }) =>
        typeof p.firstScore === 'number' &&
        typeof p.secondScore === 'number' &&
        Number.isFinite(p.firstScore) &&
        Number.isFinite(p.secondScore) &&
        p.firstScore === p.secondScore,
    );
  findings.push({
    gateId: 'C.stable_bm25',
    checkpoint: 'C',
    passed: bm25Pass,
    severity: 'P0',
    code: 'STABLE_BM25',
    detail: !probesPresent
      ? 'bm25 probe evidence missing: cannot verify lexical stability'
      : bm25Pass
        ? 'same query/document/index versions produce same lexical score'
        : 'lexical score unstable across identical queries',
  });

  // C.missing_data: P0 — REQUIRED list. Every probe uses neutral prior
  // with no redistribution.
  const missing = extras?.missingDataProbes;
  const missingPresent = Array.isArray(missing) && missing.length > 0;
  const missingPass =
    missingPresent &&
    missing.every(
      (m: { usedNeutralPrior?: unknown; redistributed?: unknown }) =>
        m.usedNeutralPrior === true && m.redistributed !== true,
    );
  findings.push({
    gateId: 'C.missing_data',
    checkpoint: 'C',
    passed: missingPass,
    severity: 'P0',
    code: 'MISSING_DATA',
    detail: !missingPresent
      ? 'missing-data evidence absent: cannot verify neutral prior'
      : missingPass
        ? 'missing evidence uses neutral prior; no weight redistribution'
        : 'missing evidence redistributed or non-neutral',
  });

  // C.grouped_scores: P1 — REQUIRED list. Output exposes all six grouped
  // dimensions and RRF never enters utility.
  const grouped = extras?.groupedOutputs;
  const groupedPresent = Array.isArray(grouped) && grouped.length > 0;
  const needDims = new Set([
    'relevance',
    'candidateFit',
    'preferenceFit',
    'marketState',
    'evidenceQuality',
    'personalAdaptation',
  ]);
  const groupedPass =
    groupedPresent &&
    grouped.every((g: { rrfInUtility?: unknown; dimensions?: unknown }) => {
      if (g.rrfInUtility === true) return false;
      if (!Array.isArray(g.dimensions)) return false;
      const dims = Array.isArray(g.dimensions) ? g.dimensions : [];
      const have = new Set(dims.map((d: unknown) => String(d)));
      return [...needDims].every((d) => have.has(d));
    });
  findings.push({
    gateId: 'C.grouped_scores',
    checkpoint: 'C',
    passed: groupedPass,
    severity: 'P1',
    code: 'GROUPED_SCORES',
    detail: !groupedPresent
      ? 'grouped output evidence missing: cannot verify dimensions'
      : groupedPass
        ? 'output exposes grouped utility dimensions; RRF not in final utility'
        : 'grouped dimensions incomplete or RRF in utility',
  });

  // C.standalone_parity: P0 — REQUIRED list. Deterministic complete runs
  // with reasoning disabled.
  const runs = extras?.standaloneRuns;
  const runsPresent = Array.isArray(runs) && runs.length > 0;
  const runsPass =
    runsPresent &&
    runs.every(
      (r: { deterministic?: unknown; reasoningDisabled?: unknown; complete?: unknown }) =>
        r.deterministic === true && r.reasoningDisabled === true && r.complete === true,
    );
  findings.push({
    gateId: 'C.standalone_parity',
    checkpoint: 'C',
    passed: runsPass,
    severity: 'P0',
    code: 'STANDALONE_PARITY',
    detail: !runsPresent
      ? 'standalone run evidence missing: cannot verify parity'
      : runsPass
        ? 'deterministic path complete with reasoning disabled'
        : 'standalone run nondeterministic, reasoning on, or incomplete',
  });

  // C.bounded_host: P1 — REQUIRED list. Every host packet bounded.
  const packets = extras?.hostPackets;
  const packetsPresent = Array.isArray(packets) && packets.length > 0;
  const packetsPass =
    packetsPresent && packets.every((p: { bounded?: unknown }) => p.bounded === true);
  findings.push({
    gateId: 'C.bounded_host',
    checkpoint: 'C',
    passed: packetsPass,
    severity: 'P1',
    code: 'BOUNDED_HOST',
    detail: !packetsPresent
      ? 'host packet evidence missing: cannot verify bounds'
      : packetsPass
        ? 'host/reasoner packets stay schema-bounded'
        : 'host packet unbounded',
  });
}

// ---------------------------------------------------------------------------
// Checkpoint D — Waves 11–14
// ---------------------------------------------------------------------------

function addCheckpointD(
  findings: GateFinding[],
  _corpora: readonly FrozenCorpus[],
  input: {
    metrics: readonly SuiteMetrics[];
    runIntegrity: { integrityFailures: number; policyFailures: number; successRate: number };
    extras?: CheckpointEvidence;
  },
): void {
  const extras = input.extras;
  // D.learning_precedence: P1 — verified by the residual unit contract, not
  // by gate input. This gate asserts the suite RAN the precedence proof:
  // REQUIRED extras.precedenceProofs with explicitWins cases.
  const prec = extras?.precedenceProofs;
  const precPresent = Array.isArray(prec) && prec.length > 0;
  const precPass =
    precPresent &&
    prec.every(
      (p: { explicitWins?: unknown; scenario?: unknown }) =>
        p.explicitWins === true && typeof p.scenario === 'string',
    );
  findings.push({
    gateId: 'D.learning_precedence',
    checkpoint: 'D',
    passed: precPass,
    severity: 'P1',
    code: 'LEARNING_PRECEDENCE',
    detail: !precPresent
      ? 'precedence proof evidence missing: run explicit-vs-learned cases'
      : precPass
        ? 'learned residual cannot override explicit preferences'
        : 'learned residual overrode an explicit preference',
  });

  // D.mcp_progressive: P1 — out of scope until MCP surface lands. REQUIRED
  // evidence would be family action descriptors; absent => explicit fail,
  // never a fake pass. (No MCP edits in this checkpoint.)
  const mcp = extras?.mcpActions;
  const mcpPresent = Array.isArray(mcp) && mcp.length > 0;
  const mcpPass =
    mcpPresent &&
    mcp.every(
      (a: { compact?: unknown; bounded?: unknown }) => a.compact === true && a.bounded === true,
    );
  findings.push({
    gateId: 'D.mcp_progressive',
    checkpoint: 'D',
    passed: mcpPass,
    severity: 'P1',
    code: 'MCP_PROGRESSIVE',
    detail: !mcpPresent
      ? 'mcp surface absent in this checkpoint: no family actions to verify'
      : mcpPass
        ? 'family actions remain compact action + bounded request'
        : 'family action violates compact/bounded contract',
  });

  // D.retention_encryption: P0 — ADR-019 DEFERRED. This gate NEVER passes:
  // retention is unsettled, so any pass would be a fake. Explicit fail with
  // deferred reason until ADR-019 settles. (D.no_open_p0p1 therefore fails
  // while this is deferred — honest signal, not a bug.)
  findings.push({
    gateId: 'D.retention_encryption',
    checkpoint: 'D',
    passed: false,
    severity: 'P0',
    code: 'RETENTION_ENCRYPTION',
    detail: 'deferred per ADR-019: retention unsettled; durable sensitive persistence blocked',
  });

  // D.no_unexplained: P1 — REQUIRED module inventory list.
  const mods = extras?.moduleInventory;
  const modsPresent = Array.isArray(mods) && mods.length > 0;
  const modsPass =
    modsPresent &&
    mods.every(
      (m: { inArchitectureTable?: unknown; module?: unknown }) =>
        m.inArchitectureTable === true && typeof m.module === 'string',
    );
  findings.push({
    gateId: 'D.no_unexplained',
    checkpoint: 'D',
    passed: modsPass,
    severity: 'P1',
    code: 'NO_UNEXPLAINED',
    detail: !modsPresent
      ? 'module inventory missing: cannot verify architecture coverage'
      : modsPass
        ? 'no module outside architecture table'
        : 'module outside architecture table',
  });

  // D.no_open_p0p1 is finalized by evaluateQualityGates after applicability is
  // known. Placeholder stays fail-closed until that aggregate step.
  findings.push({
    gateId: 'D.no_open_p0p1',
    checkpoint: 'D',
    passed: false,
    severity: 'P0',
    code: 'NO_OPEN_P0P1',
    detail: 'aggregate pending applicability evaluation',
  });
}

// ---------------------------------------------------------------------------
// Shared integrity check
// ---------------------------------------------------------------------------

function addFindingsForIntegrity(
  findings: GateFinding[],
  input: {
    checkpoint: 'A' | 'B' | 'C' | 'D';
    runIntegrity: { integrityFailures: number; policyFailures: number; successRate: number };
  },
): void {
  // Integrity failures should be 0
  findings.push({
    gateId: 'EVAL_INTEGRITY',
    checkpoint: input.checkpoint,
    passed: input.runIntegrity.integrityFailures === 0,
    severity: 'P0',
    code: 'INTEGRITY_FAILURES',
    detail: 'integrity failures: ' + String(input.runIntegrity.integrityFailures),
  });

  // Policy failures should be 0
  findings.push({
    gateId: 'EVAL_POLICY',
    checkpoint: input.runIntegrity.policyFailures === 0 ? 'A' : 'D',
    passed: input.runIntegrity.policyFailures === 0,
    severity: 'P0',
    code: 'POLICY_FAILURES',
    detail: 'policy failures: ' + String(input.runIntegrity.policyFailures),
  });

  // Success rate is always applicable for checkpoint D
  if (input.checkpoint === 'D') {
    findings.push({
      gateId: 'D.success_rate',
      checkpoint: 'D',
      passed:
        Number.isFinite(input.runIntegrity.successRate) &&
        input.runIntegrity.successRate >= 0 &&
        input.runIntegrity.successRate <= 1 &&
        input.runIntegrity.successRate >= 0.99,
      severity: 'P0',
      code: 'SUCCESS_RATE',
      detail: 'success rate: ' + String(input.runIntegrity.successRate),
    });
  }
}
