import { z } from 'zod/v4';
import { DomainPackSchema, LocalePackSchema, type DomainPack, type LocalePack } from './types.js';

export type PackKind = 'locale' | 'domain';
export type PackInput = LocalePack | DomainPack;

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/.exec(value);
    if (!match) throw new Error(`invalid semantic version: ${value}`);
    return { numbers: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? [] };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const leftNumber = a.numbers[index] ?? 0;
    const rightNumber = b.numbers[index] ?? 0;
    const difference = leftNumber - rightNumber;
    if (difference) return difference;
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length ? -1 : 1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) - Number(bv);
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function key(pack: PackInput): string {
  return `${pack.kind}:${pack.id}:${pack.version}`;
}

function activeAt(
  pack: { effectiveFrom: string; effectiveTo?: string | undefined },
  date: string,
): boolean {
  return pack.effectiveFrom <= date && (!pack.effectiveTo || date <= pack.effectiveTo);
}

/** In-memory registry. Empty by default: locale/domain knowledge is opt-in. */
export class PackRegistry {
  private readonly packs = new Map<string, PackInput>();

  constructor(inputs: readonly unknown[] = []) {
    this.registerMany(inputs);
  }

  register(input: unknown): PackInput {
    const parsed = freeze(this.parse(input));
    const packKey = key(parsed);
    if (this.packs.has(packKey)) throw new Error(`duplicate pack: ${packKey}`);
    this.packs.set(packKey, parsed);
    return parsed;
  }

  registerMany(inputs: readonly unknown[]): PackInput[] {
    return inputs.map((input) => this.register(input));
  }

  get(kind: PackKind, id: string, packVersion: string): PackInput | undefined {
    return this.packs.get(`${kind}:${id}:${packVersion}`);
  }

  list(kind?: PackKind): PackInput[] {
    return [...this.packs.values()]
      .filter((pack) => !kind || pack.kind === kind)
      .sort((left, right) => key(left).localeCompare(key(right)));
  }

  resolve(kind: PackKind, id: string, date: string): PackInput | undefined {
    const validDate = z.iso.date().parse(date);
    return this.list(kind)
      .filter((pack) => pack.id === id && activeAt(pack, validDate))
      .sort((left, right) => compareVersions(right.version, left.version))[0];
  }

  private parse(input: unknown): PackInput {
    if (!input || typeof input !== 'object' || !('kind' in input)) {
      throw new Error('invalid pack: kind is required');
    }
    const kind = (input as { kind?: unknown }).kind;
    return kind === 'locale'
      ? LocalePackSchema.parse(input)
      : kind === 'domain'
        ? DomainPackSchema.parse(input)
        : (() => {
            throw new Error(`invalid pack kind: ${String(kind)}`);
          })();
  }
}

export class LocalePackRegistry extends PackRegistry {
  register(input: unknown): LocalePack {
    const pack = LocalePackSchema.parse(input);
    return super.register(pack) as LocalePack;
  }
}

export class DomainPackRegistry extends PackRegistry {
  register(input: unknown): DomainPack {
    const pack = DomainPackSchema.parse(input);
    return super.register(pack) as DomainPack;
  }
}

export function validateLocalePack(input: unknown): LocalePack {
  return LocalePackSchema.parse(input);
}

export function validateDomainPack(input: unknown): DomainPack {
  return DomainPackSchema.parse(input);
}
