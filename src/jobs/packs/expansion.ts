import type { DomainPack } from './types.js';

const genericTokens = new Set(['officer', 'analyst', 'assistant', 'support', 'clerk']);

/** Expand only pack terms whose generic tokens have explicit contextual guards. */
export function expandDomainTerms(
  pack: DomainPack,
  terms: readonly string[],
  context: readonly string[] = [],
): string[] {
  const contextSet = new Set(context.map(normalize));
  const output = new Set<string>(terms.map((term) => term.trim()).filter(Boolean));
  const guardByToken = new Map(
    pack.expansionGuards.map((guard) => [normalize(guard.token), guard]),
  );

  for (const node of pack.roleNodes) {
    const names = [node.label, ...node.aliases];
    const matches = names.filter((name) =>
      terms.some((term) => normalize(term) === normalize(name)),
    );
    if (!matches.length) continue;
    const blocked = matches.some((name) => isBlocked(name, guardByToken, contextSet));
    if (blocked) continue;
    names.forEach((name) => output.add(name));
    pack.edges
      .filter((edge) => edge.from === node.id && edge.type === 'equivalent_title')
      .map((edge) => pack.roleNodes.find((candidate) => candidate.id === edge.to))
      .filter((candidate): candidate is DomainPack['roleNodes'][number] => Boolean(candidate))
      .filter((candidate) => !isBlocked(candidate.label, guardByToken, contextSet))
      .forEach((candidate) => output.add(candidate.label));
  }
  return [...output].sort((left, right) => left.localeCompare(right));
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isBlocked(
  name: string,
  guardByToken: ReadonlyMap<string, { requiresContext: readonly string[] }>,
  contextSet: ReadonlySet<string>,
): boolean {
  return tokenize(name)
    .filter((token) => genericTokens.has(token))
    .some((token) => {
      const guard = guardByToken.get(token);
      return !guard?.requiresContext.some((required) => contextSet.has(normalize(required)));
    });
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
