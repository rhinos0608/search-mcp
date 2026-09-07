import {
  FEEDBACK_CONTRACT_VERSION,
  FEEDBACK_PROFILE_ID,
  MAX_INTERACTIONS,
  type FeedbackExport,
  type InteractionId,
  type InteractionType,
  type LearnedResidual,
  type RecordInteractionInput,
  type RecordedInteraction,
  FeedbackError,
} from './contracts.js';
import { interactionId } from './ids.js';
import { zeroResidual, updateResidual } from './residual.js';
import { redactForExport } from './privacy.js';

// ---------------------------------------------------------------------------
// FeedbackPersistAdapter (type-only seam — no production adapter)
// ---------------------------------------------------------------------------

export interface FeedbackPersistAdapter {
  load(profileId: string): Promise<LearnedResidual | undefined>;
  save(profileId: string, residual: LearnedResidual): Promise<void>;
  deleteAll(profileId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory FeedbackStore
// ---------------------------------------------------------------------------

export interface FeedbackStore {
  record(input: RecordInteractionInput): RecordedInteraction;
  get(id: InteractionId): RecordedInteraction | undefined;
  listMeta(): { count: number; types: Record<InteractionType, number> };
  residual(): LearnedResidual;
  deleteOne(input: { election: true; interactionId: InteractionId }): boolean;
  deleteAll(input: { election: true }): void;
  exportPublic(): FeedbackExport;
}

export function createFeedbackStore(deps?: { now?: () => Date }): FeedbackStore {
  const getNow = deps?.now ?? (() => new Date());
  const rows = new Map<InteractionId, RecordedInteraction>();
  let residual: LearnedResidual = zeroResidual(getNow().toISOString());

  return {
    record(input: RecordInteractionInput): RecordedInteraction {
      const id = interactionId({
        profileId: FEEDBACK_PROFILE_ID,
        idempotencyKey: input.idempotencyKey,
      });

      const existing = rows.get(id);
      if (existing) {
        // Idempotency: same payload = return existing; different = error
        if (
          existing.type === input.type &&
          existing.postingId === input.postingId &&
          existing.rating === input.rating &&
          existing.occurredAt === input.occurredAt &&
          existing.runId === input.runId &&
          existing.featureKeys.length === input.featureKeys.length &&
          existing.featureKeys.every((fk, i) => {
            const other = input.featureKeys[i];
            if (other === undefined) return false;
            return fk.dimension === other.dimension && fk.value === other.value;
          })
        ) {
          return existing;
        }
        throw new FeedbackError('VALIDATION_ERROR', 'idempotency_payload_mismatch');
      }

      // Eviction when at capacity
      if (rows.size >= MAX_INTERACTIONS) {
        let oldestId: InteractionId | undefined;
        let oldestTime: string | undefined;
        let oldestIsView = false;

        for (const [rid, row] of rows) {
          if (oldestId === undefined) {
            oldestId = rid;
            oldestTime = row.occurredAt;
            oldestIsView = row.type === 'view';
            continue;
          }
          const rowIsView = row.type === 'view';
          // Prefer evicting views first
          if (oldestIsView && !rowIsView) continue;
          if (!oldestIsView && rowIsView) {
            oldestId = rid;
            oldestTime = row.occurredAt;
            oldestIsView = true;
            continue;
          }
          // Same category: evict by occurredAt
          if (oldestTime !== undefined && row.occurredAt < oldestTime) {
            oldestId = rid;
            oldestTime = row.occurredAt;
          }
        }

        if (oldestId !== undefined) {
          rows.delete(oldestId);
        }
      }

      const row: RecordedInteraction = {
        interactionId: id,
        contractVersion: FEEDBACK_CONTRACT_VERSION,
        profileId: FEEDBACK_PROFILE_ID,
        type: input.type,
        postingId: input.postingId,
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
        rating: input.rating,
        featureKeys: [...input.featureKeys],
        runId: input.runId,
      };

      rows.set(id, row);

      // Update residual — spread optional fields to satisfy exactOptionalPropertyTypes
      const updateInput: Parameters<typeof updateResidual>[0] = {
        residual,
        type: input.type,
        featureKeys: input.featureKeys,
        explicitPreferenceKeys: input.explicitPreferenceKeys,
        now: getNow().toISOString(),
        ...(input.rating !== undefined && { rating: input.rating }),
      };
      residual = updateResidual(updateInput);

      return row;
    },

    get(id: InteractionId): RecordedInteraction | undefined {
      return rows.get(id);
    },

    listMeta(): { count: number; types: Record<InteractionType, number> } {
      const types: Record<InteractionType, number> = {
        view: 0,
        click: 0,
        save: 0,
        apply: 0,
        dismiss: 0,
        rating: 0,
      };
      for (const row of rows.values()) {
        types[row.type] = types[row.type] + 1;
      }
      return { count: rows.size, types };
    },

    residual(): LearnedResidual {
      return residual;
    },

    deleteOne(input: { election: true; interactionId: InteractionId }): boolean {
      void input.election;
      if (!rows.has(input.interactionId)) {
        return false;
      }
      rows.delete(input.interactionId);
      // Residual not replayed — deliberate (incremental, not replay log)
      return true;
    },

    deleteAll(input: { election: true }): void {
      void input.election;
      rows.clear();
      residual = zeroResidual(getNow().toISOString());
    },

    exportPublic(): FeedbackExport {
      return redactForExport(residual);
    },
  };
}

// ---------------------------------------------------------------------------
// Profile deletion callback (documented seam for W13/orchestration)
// ---------------------------------------------------------------------------

export function onProfileDeleted(store: FeedbackStore): void {
  store.deleteAll({ election: true });
}
