import {
  LOCAL_PROFILE_ID,
  PROFILE_PERSISTENCE_CONTRACT_VERSION,
  type AdoptedProfileSnapshot,
  type ProfileCorrectionId,
  type ProfileDatabase,
  type ProfileFactId,
  type ProfilePreferenceId,
  type ProfileRevisionId,
  type ProfileStore,
  type ProfileStoreDeps,
  ProfileStoreError,
  type SavedProfilePacketId,
  type DeleteAdoptedProfileInput,
  type ResetProfileStoreInput,
  type SaveAdoptedProfileInput,
} from './contracts.js';
import { correctionId, factId, preferenceId, packetId, provenanceId, revisionId } from './ids.js';
import { applyMigrations } from './migrations.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const TERM_CATEGORIES = new Set([
  'role',
  'capability',
  'qualification',
  'licence',
  'clearance',
  'registration',
  'eligibility',
]);
const PREF_KINDS = new Set(['work_mode', 'employment_type', 'term', 'minimum_compensation']);

function validateFact(term: Record<string, unknown>, allowedTermRefs: ReadonlySet<string>): string {
  if (typeof term.kind !== 'string' || !TERM_CATEGORIES.has(term.kind)) {
    throw new ProfileStoreError('VALIDATION_ERROR', 'invalid_fact_category');
  }
  const termKey = JSON.stringify([term.kind, term.packId, term.packVersion, term.termId]);
  if (!allowedTermRefs.has(termKey)) {
    throw new ProfileStoreError('VALIDATION_ERROR', 'unapproved_profile_term');
  }
  return factId(term as { kind: string; packId: string; packVersion: string; termId: string });
}

function validatePreference(
  pref: Record<string, unknown>,
  allowedTermRefs: ReadonlySet<string>,
): string {
  if (typeof pref.kind !== 'string' || !PREF_KINDS.has(pref.kind)) {
    throw new ProfileStoreError('VALIDATION_ERROR', 'invalid_preference_kind');
  }
  if (pref.kind === 'term') {
    const value = pref.value as Record<string, unknown>;
    if (typeof value.kind !== 'string' || !TERM_CATEGORIES.has(value.kind)) {
      throw new ProfileStoreError('VALIDATION_ERROR', 'invalid_preference_term_kind');
    }
    const termKey = JSON.stringify([value.kind, value.packId, value.packVersion, value.termId]);
    if (!allowedTermRefs.has(termKey)) {
      throw new ProfileStoreError('VALIDATION_ERROR', 'unapproved_profile_term');
    }
  }
  if (pref.kind !== 'minimum_compensation' && pref.kind !== 'term') {
    if (typeof pref.value !== 'string') {
      throw new ProfileStoreError('VALIDATION_ERROR', 'invalid_preference_value');
    }
  }
  if (pref.kind === 'minimum_compensation') {
    if (
      typeof pref.amount !== 'number' ||
      typeof pref.currency !== 'string' ||
      typeof pref.period !== 'string'
    ) {
      throw new ProfileStoreError('VALIDATION_ERROR', 'invalid_compensation_fields');
    }
  }
  if (pref.explicit !== true) {
    throw new ProfileStoreError('VALIDATION_ERROR', 'preference_must_be_explicit');
  }
  return preferenceId(pref);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertElection(input: { election?: boolean }): void {
  if (input.election !== true) {
    throw new ProfileStoreError('VALIDATION_ERROR', 'election_required');
  }
}

function stripEvidenceRefs<T extends Record<string, unknown>>(obj: T): T {
  if ('evidenceRefs' in obj) {
    const copy = { ...obj };
    delete copy.evidenceRefs;
    return copy;
  }
  return obj;
}

const FACT_ARRAY_KEYS = [
  'roleHints',
  'capabilities',
  'qualifications',
  'licences',
  'clearances',
  'registrations',
  'requestedEligibility',
] as const;

// ---------------------------------------------------------------------------
// DB resolution helpers
// ---------------------------------------------------------------------------

async function fsExists(path: string): Promise<boolean> {
  const { access } = await import('node:fs/promises');
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function buildProfileSnapshot(d: ProfileDatabase): AdoptedProfileSnapshot | undefined {
  const profile = d
    .prepare('SELECT current_revision_id, updated_at FROM profiles WHERE profile_id = ?')
    .get(LOCAL_PROFILE_ID);

  if (!profile?.current_revision_id) return undefined;

  const revId = profile.current_revision_id as string;

  const facts = d
    .prepare('SELECT fact_id FROM revision_facts WHERE profile_id = ? AND revision_id = ?')
    .all(LOCAL_PROFILE_ID, revId)
    .map((r: Record<string, unknown>) => r.fact_id as ProfileFactId);

  const prefs = d
    .prepare(
      'SELECT preference_id FROM revision_preferences WHERE profile_id = ? AND revision_id = ?',
    )
    .all(LOCAL_PROFILE_ID, revId)
    .map((r: Record<string, unknown>) => r.preference_id as ProfilePreferenceId);

  const factCorrs = d
    .prepare(
      'SELECT correction_id FROM revision_fact_corrections WHERE profile_id = ? AND revision_id = ?',
    )
    .all(LOCAL_PROFILE_ID, revId)
    .map((r: Record<string, unknown>) => r.correction_id as ProfileCorrectionId);

  const prefCorrs = d
    .prepare(
      'SELECT correction_id FROM revision_preference_corrections WHERE profile_id = ? AND revision_id = ?',
    )
    .all(LOCAL_PROFILE_ID, revId)
    .map((r: Record<string, unknown>) => r.correction_id as ProfileCorrectionId);

  const correctionIds = [...factCorrs, ...prefCorrs];

  const pkt = d
    .prepare('SELECT packet_id FROM saved_profile_packets WHERE profile_id = ? AND revision_id = ?')
    .get(LOCAL_PROFILE_ID, revId);

  return {
    profileId: LOCAL_PROFILE_ID,
    revisionId: revId as ProfileRevisionId,
    adoptedAt: (profile.updated_at as string) || '',
    factIds: facts,
    preferenceIds: prefs,
    correctionIds,
    ...(pkt ? { packetId: pkt.packet_id as SavedProfilePacketId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export function createProfileStore(deps: ProfileStoreDeps): ProfileStore {
  let db: ProfileDatabase | undefined;
  let closed = false;

  const ensureDb = (): ProfileDatabase => {
    if (closed) throw new ProfileStoreError('DATABASE_LOCKED', 'store_closed');
    if (!db) throw new ProfileStoreError('DATABASE_LOCKED', 'store_not_initialized');
    return db;
  };

  /** Open existing DB for read-only operations. Do not create on first-time state. */
  const initForRead = async (): Promise<void> => {
    if (db) return;
    const key = await deps.keyProvider.read();
    const dbExists = await fsExists(deps.databasePath);

    if (!dbExists && !key) return; // First-time: no DB, no key
    if (!key) throw new ProfileStoreError('DATABASE_LOCKED', 'database_locked');
    if (!dbExists) throw new ProfileStoreError('STORE_INCONSISTENT', 'store_inconsistent');

    db = deps.databaseOpener.open(deps.databasePath, key);
    applyMigrations(db);
  };

  /** Open or create DB for write operations. Generates key on first save. */
  const initForWrite = async (): Promise<void> => {
    if (db) return;
    const key = await deps.keyProvider.read();
    const dbExists = await fsExists(deps.databasePath);

    if (!dbExists && !key) {
      const generateKey =
        deps.randomKey ??
        (() => {
          const k = new Uint8Array(32);
          globalThis.crypto.getRandomValues(k);
          return k;
        });
      const newKey = generateKey();
      await deps.keyProvider.write(newKey);
      db = deps.databaseOpener.open(deps.databasePath, newKey);
      applyMigrations(db);
      return;
    }

    if (!key) throw new ProfileStoreError('DATABASE_LOCKED', 'database_locked');
    if (!dbExists) throw new ProfileStoreError('STORE_INCONSISTENT', 'store_inconsistent');

    db = deps.databaseOpener.open(deps.databasePath, key);
    applyMigrations(db);
  };

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const loadAdoptedProfile = async (): Promise<AdoptedProfileSnapshot | undefined> => {
    await initForRead();
    if (!db) return undefined;
    return buildProfileSnapshot(db);
  };

  const saveAdoptedProfile = async (
    input: SaveAdoptedProfileInput,
  ): Promise<AdoptedProfileSnapshot> => {
    assertElection(input);

    const { result } = input;
    if (result.status !== 'minimized') {
      throw new ProfileStoreError('VALIDATION_ERROR', 'minimized_result_required');
    }

    // Reject observed facts BEFORE stripping them
    const draftInput = result.draft as Record<string, unknown>;
    if (
      Array.isArray(draftInput.observedCandidateFacts) &&
      (draftInput.observedCandidateFacts as unknown[]).length > 0
    ) {
      throw new ProfileStoreError('VALIDATION_ERROR', 'observed_facts_not_allowed');
    }

    // Deep clone draft and strip evidence IDs
    const draft = JSON.parse(JSON.stringify(result.draft)) as Record<string, unknown>;
    for (const key of FACT_ARRAY_KEYS) {
      (draft[key] as Record<string, unknown>[]).map((item: Record<string, unknown>) =>
        stripEvidenceRefs(item),
      );
    }
    (draft.preferences as Record<string, unknown>[]).map((p: Record<string, unknown>) =>
      stripEvidenceRefs(p),
    );
    draft.observedCandidateFacts = [];
    draft.evidenceRefs = [];

    // Validate and compute fact IDs
    const factIdsList: string[] = [];
    for (const key of FACT_ARRAY_KEYS) {
      for (const item of draft[key] as Record<string, unknown>[]) {
        factIdsList.push(validateFact(item.term as Record<string, unknown>, deps.allowedTermRefs));
      }
    }

    // Validate and compute preference IDs
    const prefIdsList: string[] = [];
    for (const p of draft.preferences as Record<string, unknown>[]) {
      prefIdsList.push(validatePreference(p, deps.allowedTermRefs));
    }

    // Process corrections
    const correctionIdsList: string[] = [];
    const factCorrections: {
      correctionId: string;
      priorFactId: string;
      replacementFactId: string | null;
    }[] = [];
    const prefCorrections: {
      correctionId: string;
      priorPrefId: string;
      replacementPreferenceId: string | null;
    }[] = [];

    for (const correction of input.corrections ?? []) {
      if (correction.kind === 'fact') {
        const priorFid = factId(
          correction.prior as { kind: string; packId: string; packVersion: string; termId: string },
        );
        const replacementFid = correction.replacement
          ? factId(
              correction.replacement as {
                kind: string;
                packId: string;
                packVersion: string;
                termId: string;
              },
            )
          : null;
        const cid = correctionId('fact', priorFid, replacementFid);
        correctionIdsList.push(cid);
        factCorrections.push({
          correctionId: cid,
          priorFactId: priorFid,
          replacementFactId: replacementFid,
        });
      } else {
        const priorPid = preferenceId(correction.prior);
        const replacementPid = correction.replacement ? preferenceId(correction.replacement) : null;
        const cid = correctionId('preference', priorPid, replacementPid);
        correctionIdsList.push(cid);
        prefCorrections.push({
          correctionId: cid,
          priorPrefId: priorPid,
          replacementPreferenceId: replacementPid,
        });
      }
    }

    const revId = revisionId(factIdsList, prefIdsList, correctionIdsList);
    const provId = provenanceId(LOCAL_PROFILE_ID, revId);
    const ts = new Date().toISOString();

    await initForWrite();
    const d = ensureDb();

    // Optimistic revision check — null rejected (fail-closed)
    if (input.expectedRevision === null) {
      throw new ProfileStoreError('VALIDATION_ERROR', 'expected_revision_required');
    }
    {
      const current = d
        .prepare('SELECT current_revision_id FROM profiles WHERE profile_id = ?')
        .get(LOCAL_PROFILE_ID);
      if (current?.current_revision_id !== input.expectedRevision) {
        throw new ProfileStoreError('REVISION_CONFLICT', 'revision_conflict');
      }
    }

    d.exec('SAVEPOINT w2b_save');
    try {
      // Upsert profile
      d.prepare(
        `INSERT INTO profiles (profile_id, contract_version, current_revision_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET
           current_revision_id = excluded.current_revision_id,
           updated_at = excluded.updated_at`,
      ).run(LOCAL_PROFILE_ID, PROFILE_PERSISTENCE_CONTRACT_VERSION, revId, ts, ts);

      // Insert revision (idempotent for same revision)
      d.prepare(
        'INSERT OR IGNORE INTO profile_revisions (profile_id, revision_id, adopted_at) VALUES (?, ?, ?)',
      ).run(LOCAL_PROFILE_ID, revId, ts);

      // Insert provenance (idempotent)
      d.prepare(
        'INSERT OR IGNORE INTO profile_provenance (profile_id, provenance_id, revision_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(LOCAL_PROFILE_ID, provId, revId, 'user_adoption', ts);

      // Insert facts
      const insertFact = d.prepare(
        'INSERT OR IGNORE INTO profile_fact_values (profile_id, fact_id, category, pack_id, pack_version, term_id, origin, data_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const insertRevFact = d.prepare(
        'INSERT OR IGNORE INTO revision_facts (profile_id, revision_id, fact_id, provenance_id) VALUES (?, ?, ?, ?)',
      );

      let fi = 0;
      for (const key of FACT_ARRAY_KEYS) {
        for (const item of draft[key] as Record<string, unknown>[]) {
          const term = item.term as Record<string, unknown>;
          insertFact.run(
            LOCAL_PROFILE_ID,
            factIdsList[fi],
            term.kind,
            term.packId,
            term.packVersion,
            term.termId,
            'user_supplied',
            'job_fact',
          );
          insertRevFact.run(LOCAL_PROFILE_ID, revId, factIdsList[fi], provId);
          fi++;
        }
      }

      // Insert preferences
      const insertPref = d.prepare(
        `INSERT OR IGNORE INTO profile_preference_values
         (profile_id, preference_id, kind, dimension, scalar_value, term_kind, pack_id, pack_version, term_id, amount, currency, period, desired, explicit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertRevPref = d.prepare(
        'INSERT OR IGNORE INTO revision_preferences (profile_id, revision_id, preference_id, provenance_id) VALUES (?, ?, ?, ?)',
      );

      const prefArray = draft.preferences as Record<string, unknown>[];
      for (let i = 0; i < prefArray.length; i++) {
        const p = prefArray[i];
        if (!p) continue;
        const pid = prefIdsList[i];
        if (!pid) continue;

        let dimension: string | null = null;
        let scalarValue: string | null = null;
        let termKind: string | null = null;
        let pPackId: string | null = null;
        let pPackVersion: string | null = null;
        let pTermId: string | null = null;
        let amount: number | null = null;
        let currency: string | null = null;
        let period: string | null = null;

        if (p.kind === 'term') {
          const val = p.value as Record<string, unknown>;
          dimension = val.kind as string;
          termKind = val.kind as string;
          pPackId = val.packId as string;
          pPackVersion = val.packVersion as string;
          pTermId = val.termId as string;
        } else if (p.kind === 'minimum_compensation') {
          amount = p.amount as number;
          currency = p.currency as string;
          period = p.period as string;
        } else {
          scalarValue = p.value as string;
        }

        insertPref.run(
          LOCAL_PROFILE_ID,
          pid,
          p.kind,
          dimension,
          scalarValue,
          termKind,
          pPackId,
          pPackVersion,
          pTermId,
          amount,
          currency,
          period,
          p.desired ? 1 : 0,
          1,
        );
        insertRevPref.run(LOCAL_PROFILE_ID, revId, pid, provId);
      }

      // Insert corrections
      const insertFactCorr = d.prepare(
        'INSERT OR IGNORE INTO revision_fact_corrections (profile_id, revision_id, correction_id, prior_fact_id, replacement_fact_id, provenance_id) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const fc of factCorrections) {
        insertFactCorr.run(
          LOCAL_PROFILE_ID,
          revId,
          fc.correctionId,
          fc.priorFactId,
          fc.replacementFactId,
          provId,
        );
      }

      const insertPrefCorr = d.prepare(
        'INSERT OR IGNORE INTO revision_preference_corrections (profile_id, revision_id, correction_id, prior_preference_id, replacement_preference_id, provenance_id) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const pc of prefCorrections) {
        insertPrefCorr.run(
          LOCAL_PROFILE_ID,
          revId,
          pc.correctionId,
          pc.priorPrefId,
          pc.replacementPreferenceId,
          provId,
        );
      }

      // Insert saved packet if requested (idempotent)
      if (input.savePacket?.election === true) {
        const pktId = packetId(LOCAL_PROFILE_ID, revId);
        d.prepare(
          'INSERT OR IGNORE INTO saved_profile_packets (profile_id, packet_id, revision_id, saved_at) VALUES (?, ?, ?, ?)',
        ).run(LOCAL_PROFILE_ID, pktId, revId, ts);
      }

      d.exec('RELEASE SAVEPOINT w2b_save');
    } catch (err) {
      d.exec('ROLLBACK TO SAVEPOINT w2b_save');
      throw err;
    }

    const snapshot = buildProfileSnapshot(d);
    if (!snapshot) throw new ProfileStoreError('STORE_INCONSISTENT', 'store_inconsistent');
    return snapshot;
  };

  const deleteAdoptedProfile = async (input: DeleteAdoptedProfileInput): Promise<boolean> => {
    assertElection(input);
    await initForWrite();
    const d = ensureDb();

    const profile = d
      .prepare('SELECT current_revision_id FROM profiles WHERE profile_id = ?')
      .get(LOCAL_PROFILE_ID);

    if (!profile?.current_revision_id) return false;
    if (profile.current_revision_id !== input.expectedRevision) {
      throw new ProfileStoreError('REVISION_CONFLICT', 'revision_conflict');
    }

    d.exec('SAVEPOINT w2b_delete');
    try {
      d.prepare('DELETE FROM profiles WHERE profile_id = ?').run(LOCAL_PROFILE_ID);
      d.exec('RELEASE SAVEPOINT w2b_delete');
    } catch (err) {
      d.exec('ROLLBACK TO SAVEPOINT w2b_delete');
      throw err;
    }

    return true;
  };

  const resetProfileStore = async (input: ResetProfileStoreInput): Promise<void> => {
    assertElection(input);
    if (db) {
      db.close();
      db = undefined;
    }
    closed = false;

    const fs = await import('node:fs/promises');
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        await fs.unlink(deps.databasePath + suffix);
      } catch {
        // File may not exist
      }
    }
    await deps.keyProvider.delete();
  };

  const close = (): void => {
    if (db) {
      db.close();
      db = undefined;
    }
    closed = true;
  };

  return { loadAdoptedProfile, saveAdoptedProfile, deleteAdoptedProfile, resetProfileStore, close };
}
