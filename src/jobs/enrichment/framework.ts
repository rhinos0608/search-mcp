import type { Classification } from '../domain/posting.js';
import type { EnrichmentWarning, ExtractedFieldSnapshot, LocalePack } from './contracts.js';

export interface FrameworkEnrichmentResult {
  readonly mapped: Classification[];
  readonly unmapped: Classification[];
  readonly warnings: EnrichmentWarning[];
  readonly flags: readonly string[];
}

export function interpretFramework(
  snapshot: ExtractedFieldSnapshot,
  localePack: LocalePack | undefined,
  _clock: { producedAt: string },
): FrameworkEnrichmentResult {
  const mapped: Classification[] = [];
  const unmapped: Classification[] = [];
  const warnings: EnrichmentWarning[] = [];
  const flags: string[] = [];

  for (const cls of snapshot.classifications ?? []) {
    if (!localePack) {
      unmapped.push(cls);
      warnings.push({ code: 'FRAMEWORK_UNMAPPED', fieldPath: 'classifications' });
      continue;
    }

    const scheme = localePack.classificationSchemes.find(
      (s) =>
        s.id.toLocaleLowerCase() === cls.scheme.toLocaleLowerCase() ||
        s.name.toLocaleLowerCase() === cls.scheme.toLocaleLowerCase(),
    );
    if (!scheme) {
      unmapped.push(cls);
      warnings.push({ code: 'FRAMEWORK_UNMAPPED', fieldPath: 'classifications' });
      continue;
    }

    const valueMatch = scheme.values.some(
      (v) => v.toLocaleLowerCase() === cls.value.toLocaleLowerCase(),
    );
    if (!valueMatch) {
      unmapped.push(cls);
      warnings.push({ code: 'FRAMEWORK_UNMAPPED', fieldPath: 'classifications' });
      continue;
    }

    // Use pack canonical casing for value
    const canonicalValue =
      scheme.values.find((v) => v.toLocaleLowerCase() === cls.value.toLocaleLowerCase()) ??
      cls.value;
    mapped.push({
      scheme: scheme.id,
      value: canonicalValue,
      level: cls.level,
    });
  }

  // ADR-016: clinical title registration gap check
  const clinicalTokens = ['nurse', 'medical', 'clinical', 'practitioner'];
  const titleLower = (snapshot.title ?? '').toLocaleLowerCase();
  const hasClinicalToken = clinicalTokens.some((t) => titleLower.includes(t));
  if (hasClinicalToken) {
    const hasRegistration = snapshot.requirements?.some((r) => r.category === 'registration');
    if (!hasRegistration) {
      flags.push('registration_not_evidenced');
      warnings.push({ code: 'CLINICAL_TITLE_NOT_REGULATION' });
    }
  }

  return { mapped, unmapped, warnings, flags };
}
