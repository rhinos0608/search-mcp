export type EnrichmentErrorCode =
  | 'VALIDATION_ERROR'
  | 'CONTRACT_MISMATCH'
  | 'PACK_UNAVAILABLE'
  | 'UNVERIFIED_EMPLOYER'
  | 'BUDGET_EXHAUSTED'
  | 'INTERNAL_ERROR';

export class EnrichmentError extends Error {
  override readonly name = 'EnrichmentError' as const;
  readonly code: EnrichmentErrorCode;
  readonly retryable = false as const;

  constructor(code: EnrichmentErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
