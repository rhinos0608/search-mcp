export const MAX_ELEMENTS = 50;
export const MAX_RAW_ELEMENTS = 1000;
export const MAX_TEXT_LENGTH = 10000;
export const TRUNCATED_MARKER = '... [truncated]';

export interface TruncatedValue {
  value: string;
  truncated?: true;
  originalLength?: number;
}

export function truncateElementText(text: string): TruncatedValue {
  if (text.length <= MAX_TEXT_LENGTH) {
    return { value: text };
  }

  return {
    value: text.slice(0, MAX_TEXT_LENGTH) + TRUNCATED_MARKER,
    truncated: true,
    originalLength: text.length,
  };
}
