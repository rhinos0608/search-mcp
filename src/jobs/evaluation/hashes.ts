import { createHash } from 'node:crypto';
import type { EvalManifest, Sha256Hex } from './types.js';

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/** Sort object keys by UTF-16 code-point (JS default). Drop undefined values. */
function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k];
    if (v === undefined) continue;
    sorted[k] = canonicalValue(v);
  }
  return sorted;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

export function sha256Hex(canonical: string): Sha256Hex {
  return createHash('sha256').update(canonical, 'utf8').digest('hex').toLowerCase();
}

// ---------------------------------------------------------------------------
// Manifest hash
// ---------------------------------------------------------------------------

export function computeManifestHash(manifest: Omit<EvalManifest, 'manifestHash'>): Sha256Hex {
  // Omit at runtime: strip manifestHash before hashing
  const { manifestHash: _, ...rest } = manifest as EvalManifest;
  return sha256Hex(canonicalJson(rest));
}
