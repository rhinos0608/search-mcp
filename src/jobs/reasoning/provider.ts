import type { ReasoningPacket } from './contracts.js';

/**
 * Optional bounded reasoning provider port.
 * Provider failures are not errors — they degrade to fallback.
 */
export interface ReasoningProvider {
  readonly id: string;
  readonly model: string;
  complete(input: { packet: ReasoningPacket; signal?: AbortSignal }): Promise<{ text: string }>;
}
