import type { Classification } from '../domain/posting.js';
import type { EnrichmentWarning, LocalePack } from './contracts.js';

export interface ClassificationMappingResult {
  readonly mapped: Classification[];
  readonly unmapped: Classification[];
  readonly warnings: EnrichmentWarning[];
}

export function mapClassification(
  classifications: readonly Classification[],
  localePack: LocalePack | undefined,
): ClassificationMappingResult {
  const mapped: Classification[] = [];
  const unmapped: Classification[] = [];
  const warnings: EnrichmentWarning[] = [];

  for (const cls of classifications) {
    if (!localePack) {
      unmapped.push(cls);
      continue;
    }

    const scheme = localePack.classificationSchemes.find(
      (s) =>
        s.id.toLocaleLowerCase() === cls.scheme.toLocaleLowerCase() ||
        s.name.toLocaleLowerCase() === cls.scheme.toLocaleLowerCase(),
    );
    if (!scheme) {
      unmapped.push(cls);
      continue;
    }

    const valueMatch = scheme.values.some(
      (v) => v.toLocaleLowerCase() === cls.value.toLocaleLowerCase(),
    );
    if (!valueMatch) {
      unmapped.push(cls);
      continue;
    }

    const canonicalValue =
      scheme.values.find((v) => v.toLocaleLowerCase() === cls.value.toLocaleLowerCase()) ??
      cls.value;
    mapped.push({
      scheme: scheme.id,
      value: canonicalValue,
      level: cls.level,
    });
  }

  if (unmapped.length > 0) {
    warnings.push({ code: 'CLASSIFICATION_UNMAPPED', fieldPath: 'classifications' });
  }

  return { mapped, unmapped, warnings };
}
