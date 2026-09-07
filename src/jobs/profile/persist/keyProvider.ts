import type { ProfileKeyProvider } from './contracts.js';

/**
 * In-memory key provider for tests and CI.
 * Keys are lost when the process exits.
 */
export class MemoryKeyProvider implements ProfileKeyProvider {
  #key: Uint8Array | undefined;

  async read(): Promise<Uint8Array | undefined> {
    return this.#key;
  }

  async write(key: Uint8Array): Promise<void> {
    this.#key = key;
  }

  async delete(): Promise<void> {
    this.#key = undefined;
  }
}
