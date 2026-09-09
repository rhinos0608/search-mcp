import { createHash } from 'node:crypto';

import { ACQUISITION_CONTRACT_VERSION } from './contracts.js';

export const ACQUISITION_ADAPTER_SUPPORT_VERSION = '1.0.0' as const;

export const ACQUISITION_ID_MAX_PARTS = 32 as const;

export const ACQUISITION_ID_MAX_PREIMAGE_BYTES = 32768 as const;

export type AcquisitionArtifactKind =
  | 'candidate'
  | 'evidence'
  | 'envelope'
  | 'listing'
  | 'observation';

const ARTIFACT_KINDS = new Set<AcquisitionArtifactKind>([
  'candidate',
  'evidence',
  'envelope',
  'listing',
  'observation',
]);

export interface HttpUrlMetadata {
  readonly rawUrl: string;
  readonly canonicalUrl: string;
  readonly normalizedHost: string;
}

export function deterministicAcquisitionId(
  kind: AcquisitionArtifactKind,
  parts: readonly string[],
): string {
  if (typeof kind !== 'string') {
    throw new TypeError('acquisition artifact kind must be a string');
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- runtime kind check
  if (!ARTIFACT_KINDS.has(kind as AcquisitionArtifactKind)) {
    throw new RangeError('invalid acquisition artifact kind');
  }
  if (!Array.isArray(parts)) {
    throw new TypeError('acquisition ID parts must be an array');
  }
  if (parts.length > ACQUISITION_ID_MAX_PARTS) {
    throw new RangeError('acquisition ID parts exceed limit');
  }
  for (const p of parts) {
    if (typeof p !== 'string') {
      throw new TypeError('acquisition ID parts must contain only strings');
    }
  }
  const copy = [...(parts as readonly string[])];
  const payload = JSON.stringify([ACQUISITION_CONTRACT_VERSION, ...copy]);
  if (Buffer.byteLength(payload, 'utf8') > ACQUISITION_ID_MAX_PREIMAGE_BYTES) {
    throw new RangeError('acquisition ID preimage exceeds limit');
  }
  const hex = createHash('sha256').update(payload, 'utf8').digest('hex').toLowerCase();
  return `${kind}:${hex}`;
}

export function acquiredContentHash(content: string): string {
  if (typeof content !== 'string') {
    throw new TypeError('content must be a string');
  }
  const hex = createHash('sha256').update(content, 'utf8').digest('hex').toLowerCase();
  const out = `sha256:${hex}`;
  if (out.length > 256) {
    throw new RangeError('content hash exceeds W3-A bound 256');
  }
  return out;
}

// Credential-shaped query parameters. Two layers:
// 1. Separator-bounded sensitive terms (token, api_key, auth_code, sig, ...).
// 2. camelCase credential compounds (accessToken, authCode, clientSecret,
//    bearerToken, ...) where a credential word prefixes the sensitive term.
//    Benign camelCase compounds with non-credential prefixes (jobCode,
//    postcode, authority) stay allowed.
const CREDENTIAL_PARAM_RE =
  /(?:^|[_-])(?:token|secret|password|passwd|authorization|auth|api[_-]?key|signature|sig|code)(?:[_-]|$)/iu;
const CAMEL_CREDENTIAL_PARAM_RE =
  /(?:access|client|auth|oauth|bearer|consumer)[_-]?(?:token|secret|code|key|password)/i;

function isCredentialQueryParam(key: string): boolean {
  return CREDENTIAL_PARAM_RE.test(key) || CAMEL_CREDENTIAL_PARAM_RE.test(key);
}

export function normalizeHttpUrlMetadata(input: string): Readonly<HttpUrlMetadata> | undefined {
  try {
    if (typeof input !== 'string') {
      return undefined;
    }
    if (input.length > 8192) {
      return undefined;
    }
    const rawUrl = input.trim();
    if (rawUrl.length === 0) {
      return undefined;
    }
    if (rawUrl.length > 8192) {
      return undefined;
    }
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return undefined;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      return undefined;
    }
    const normalizedHost = parsed.hostname.toLowerCase();
    if (normalizedHost.length === 0) {
      return undefined;
    }
    if (normalizedHost.length > 253) {
      return undefined;
    }
    parsed.hash = '';
    for (const key of parsed.searchParams.keys()) {
      if (isCredentialQueryParam(key)) {
        return undefined;
      }
    }
    const canonicalUrl = parsed.toString();
    if (canonicalUrl.length > 8192) {
      return undefined;
    }
    const result: HttpUrlMetadata = { rawUrl, canonicalUrl, normalizedHost };
    return Object.freeze(result);
  } catch {
    return undefined;
  }
}
