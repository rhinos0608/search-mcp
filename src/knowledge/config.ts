/**
 * Knowledge Graph configuration — defaults, resolution, and env var wiring.
 *
 * The KnowledgeGraphConfig interface lives in types.ts alongside the
 * rest of the data model. This module provides defaults and helpers
 * for resolving configuration from partial input.
 */

import path from 'node:path';
import os from 'node:os';
import type { KnowledgeGraphConfig } from './types.js';

// ────────────────────────────────────────────────────────────────────
// Defaults
// ────────────────────────────────────────────────────────────────────

export const DEFAULT_KG_CONFIG: KnowledgeGraphConfig = {
  enabled: false,
  dbPath: '~/.cache/search-mcp/kg/kg.sqlite',
  projection: {
    maxEvents: 500,
    maxAgeMs: 86_400_000,
  },
  solidification: {
    minRuns: 2,
    minEntities: 5,
    highConfidenceOverride: 0.85,
    minVerbatimRatio: 0.7,
    minSourceCount: 3,
  },
  session: {
    maxBufferItems: 20,
    maxIdleMs: 300_000,
    captureStdio: true,
  },
  consolidation: {
    cadenceMs: 604_800_000,
    annThreshold: 200,
    maxFamilies: 300,
  },
  relations: {
    maxFamilies: 100,
    maxNodesPerFamily: 100,
  },
};

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Resolve `~` in a path to the user's home directory.
 */
export function resolveKgDbPath(cfg: KnowledgeGraphConfig): string {
  if (cfg.dbPath.startsWith('~/')) {
    return path.join(os.homedir(), cfg.dbPath.slice(2));
  }
  return cfg.dbPath;
}

/**
 * Merge a partial configuration with defaults.
 *
 * The environment variables KG_ENABLED and KG_DB_PATH are applied
 * at the config-file/global level (see loadConfig in src/config.ts).
 * This function handles programmatic overrides (e.g. from tests or
 * dynamic tool call options).
 */
export function resolveKgConfig(partial?: Partial<KnowledgeGraphConfig>): KnowledgeGraphConfig {
  const base: KnowledgeGraphConfig = structuredClone(DEFAULT_KG_CONFIG);

  if (partial === undefined) return base;

  return {
    ...base,
    ...partial,
    projection: {
      ...base.projection,
      ...(partial.projection ?? {}),
    },
    solidification: {
      ...base.solidification,
      ...(partial.solidification ?? {}),
    },
    session: {
      ...base.session,
      ...(partial.session ?? {}),
    },
    consolidation: {
      ...base.consolidation,
      ...(partial.consolidation ?? {}),
    },
    relations: {
      ...base.relations,
      ...(partial.relations ?? {}),
    },
  };
}
