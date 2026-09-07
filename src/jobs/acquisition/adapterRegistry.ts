import {
  ADAPTER_CAPABILITY_CONTRACT_VERSION,
  AdapterCapabilitySchema,
  AdapterEdgeCapabilitySchema,
  type AdapterCapability,
  type AdapterEdgeCapability,
} from './adapterCapability.js';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function cloneFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) ?? 0;
    const cb = b.codePointAt(j) ?? 0;
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i >= a.length && j >= b.length) return 0;
  return i >= a.length ? -1 : 1;
}

export class AdapterCapabilityRegistry {
  private readonly byId = new Map<string, AdapterCapability>();

  constructor(initial: readonly unknown[] = []) {
    for (const item of initial) {
      this.register(item);
    }
  }

  register(input: unknown): AdapterCapability {
    const parsed = AdapterCapabilitySchema.parse(input);
    if (this.byId.has(parsed.adapterId)) {
      throw new Error(`duplicate adapter capability: ${parsed.adapterId}`);
    }
    const frozen = cloneFrozen(parsed);
    this.byId.set(frozen.adapterId, frozen);
    return frozen;
  }

  get(adapterId: string): AdapterCapability | undefined {
    const found = this.byId.get(adapterId);
    return found === undefined ? undefined : cloneFrozen(found);
  }

  list(): readonly AdapterCapability[] {
    const sorted = [...this.byId.values()].sort((a, b) =>
      compareCodePoints(a.adapterId, b.adapterId),
    );
    const frozenItems = sorted.map((c) => cloneFrozen(c));
    return deepFreeze(frozenItems);
  }

  supports(adapterId: string, edge: AdapterEdgeCapability): boolean {
    const parsed = AdapterEdgeCapabilitySchema.parse(edge);
    const cap = this.byId.get(adapterId);
    if (!cap) return false;
    return cap.edges.some(
      (e) =>
        e.operation === parsed.operation &&
        e.route === parsed.route &&
        e.targetKind === parsed.targetKind,
    );
  }

  listSupporting(edge: AdapterEdgeCapability): readonly AdapterCapability[] {
    const parsed = AdapterEdgeCapabilitySchema.parse(edge);
    const filtered = [...this.byId.values()].filter((cap) =>
      cap.edges.some(
        (e) =>
          e.operation === parsed.operation &&
          e.route === parsed.route &&
          e.targetKind === parsed.targetKind,
      ),
    );
    filtered.sort((a, b) => compareCodePoints(a.adapterId, b.adapterId));
    const frozenItems = filtered.map((c) => cloneFrozen(c));
    return deepFreeze(frozenItems);
  }
}

export { ADAPTER_CAPABILITY_CONTRACT_VERSION };
