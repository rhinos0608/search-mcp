# Domain-Facts Registry

A generated, provenance-pinned snapshot of external **facts** about domains, used
by `src/utils/sourceTier.ts` to promote research/education organizations to the
existing institutional prior. Everything is derived at build time from
SHA-256-pinned source inputs — there is **no runtime network call**.

## Semantics and limitations

This registry is a source of **facts**, not truth or reputation:

- **CISA dotgov-data** (`current-full.csv`) means _"this domain is registered
  to a US government organization"_ (federal, state/territory, county, city,
  tribal, school district, special district, interstate, or an election-office
  variant of any of these). It is an **ownership** fact. It is not a statement
  that government content is true, authoritative, or current.
- **ROR** (Research Organization Registry) means _"this organization is
  registered in ROR with these identity types."_ It is an **identity** fact. It
  is not reputation, and it is not a claim about research quality.

The registry never assigns scores itself. Ranking policy (which fact maps to
which institutional prior) lives in `src/utils/sourceTier.ts`.

## Sources and provenance

| Source           | Input                                                     | Release / version                                                                                                                                                                                                   | SHA-256 of input                                                   | License |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------- |
| CISA dotgov-data | `current-full.csv`                                        | commit [`c44e0fa675a8875eb685e9bb84b5a68e4f8e0f42`](https://github.com/cisagov/dotgov-data/commit/c44e0fa675a8875eb685e9bb84b5a68e4f8e0f42) (2026-08-12; no release tags; pinned by immutable commit SHA + SHA-256) | `335ff0a8c829d495444c1211673a2f9d8da0793fcb2349d1034773d221e27e1f` | CC0-1.0 |
| ROR              | `v2.7-2026-05-12-ror-data.zip` (Zenodo record `20140273`) | `v2.7-2026-05-12`                                                                                                                                                                                                   | `4acfbaeab99539c5d616d3a90fe8854f092fe28d4b982a69cb1f2b576aba86a8` | CC0-1.0 |

The exact pins live in `src/domainFacts/sources.ts` and are embedded in the
generated `registry.generated.ts` `PROVENANCE`. A mutable URL alone is never a
version pin; `version` plus `sha256` pin the exact bytes. The CISA URL is
pinned to an immutable raw-content URL at a specific Git commit (rather than
the mutable `main` branch), so the retrieved bytes cannot change under the
pin. Source content is treated as **untrusted data**: it is parsed, never
executed.

## Generated file

| File                                    | Contents                                                                                                         | Approx. size |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------ |
| `src/domainFacts/registry.generated.ts` | `PROVENANCE`, `REGISTRY_VERSION`, `CISA_ROWS`, `ROR_ROWS`, `INSTITUTIONAL_DOMAINS` (education-qualified domains) | ~3.6 MB      |

Everything renders into and publishes as this single module. There is
deliberately no second generated file: an earlier revision split
`INSTITUTIONAL_DOMAINS` into its own `institutional.generated.ts`, which
required a two-file publish and left a window where a crash between the two
file renames could leave one file updated and the other stale. Consolidating
to one file removes that window entirely — see "Determinism and atomicity"
below.

Row schemas:

- `CisaRow = [domain, type, org, suborg]` — registered US government ownership.
- `RorRow = [domain, rorId, name, types]` — active organization identity.

Only ROR records with `status === "active"` are emitted. A CISA ownership fact
and a ROR identity fact may coexist for the same domain (e.g. `anl.gov`, which
is both a DOE lab domain and a ROR organization); both are retained with full
provenance.

## Type gating (which facts promote)

`INSTITUTIONAL_ROR_TYPES` in `src/domainFacts/types.ts` controls which ROR
organization types map to the existing institutional 0.70 prior/basis
(the same value/basis as the `.edu` / `.ac.[a-z]{2}` tier in `sourceTier.ts`).

- **Qualifying:** `education`.
- **Facts only (never promoted):** `company`, `funder`, `nonprofit`,
  `healthcare`, `facility`, `other`, `government`, `archive`, and any unknown
  type.

This deliberately does **not** promote all research participants equally. For
example `anl.gov` (ROR types `facility`/`funder`) remains a fact but receives no
boost, while `mit.edu` (`education`) maps to the 0.70 institutional prior.

## Ranking integration (`sourceTier.ts`)

A domain is treated as institutional when it equals a registered institutional
domain or is a **controlled child host** of one (`host === dom ||
host.endsWith('.' + dom)` — the boundary dot prevents parent/sibling/suffix
false positives). Promotion is applied **after** every manual exact/curated/
platform-low rule (those keep highest priority) and only when the domain is not
already covered by an equal-or-higher government/academic suffix tier (`.gov`,
`.mil`, `.edu`, `.ac.*`), so no existing domain's score is ever lowered.

The numeric weights and the ranking formula are unchanged; this adds a
promotion floor for education organizations whose domain would otherwise rank
below 0.70. Tests in `test/domainFacts/sourceTier.integration.test.ts` pin the
baseline values.

## Generation, update, and check

No new dependencies. Scripts use only Node/TypeScript built-ins and run under
`tsx`.

```bash
# Regenerate from pinned sources (downloads HTTPS, verifies SHA-256, validates,
# and atomically writes). Nonzero exit + no partial output on any failure.
npx tsx scripts/generate-domain-facts.ts

# Use an existing local cache without downloading.
npx tsx scripts/generate-domain-facts.ts --skip-download --cache-dir /path

# Check the committed registry is in sync with pinned sources.
npx tsx scripts/check-domain-facts.ts
```

Source inputs are cached in `~/.cache/search-mcp/domain-facts/` by default
(override with `DOMAIN_FACTS_CACHE_DIR` or `--cache-dir`). Downloads are HTTPS
only.

### Determinism and atomicity

- `buildRegistry` sorts every fact stream deterministically; `renderRegistry`
  emits byte-identical output for identical inputs, in a single string
  containing `PROVENANCE`, `REGISTRY_VERSION`, `CISA_ROWS`, `ROR_ROWS`, and
  `INSTITUTIONAL_DOMAINS` together.
- `verifySha256` throws on any checksum mismatch → the generator exits nonzero.
- The pipeline is **validate before output**: `validateRegistry` runs strictly
  before `writeGeneratedFileAtomic`, so a failed build/validation never
  leaves partial or stale output.
- `writeGeneratedFileAtomic` publishes the single generated file by writing a
  temp file in the same directory, `fsync`-ing its data, then `rename(2)`-ing
  it onto the final path, followed by a best-effort `fsync` of the
  containing directory. Because there is exactly one generated file, publish
  is a single `rename(2)` call — there is no multi-file window in which a
  reader could observe one dataset updated and another stale; the datasets
  either all update together (the rename lands) or none do (the rename never
  happens and the previous file is untouched).

  **Exact guarantee:** POSIX `rename(2)` on the same filesystem is atomic
  with respect to concurrent readers of the final path — a reader always
  observes either the complete old bytes or the complete new bytes, never a
  partial or mixed file, as long as the temp file and `outDir` are on the
  same mounted filesystem (always true here, since both live under
  `outDir`). Any error before the rename (temp write/fsync) or during the
  rename itself leaves the previously published file completely untouched
  and removes the temp file.

  **What this does not guarantee:** durability across a hard crash or power
  loss between the temp-file `fsync` and the rename, or between the rename
  and the best-effort directory `fsync`. Whether a completed rename survives
  a crash depends on the filesystem/mount options (e.g. ext4
  `data=ordered` vs `data=writeback`), which this function cannot control
  from userspace. The directory `fsync` is skipped outright on platforms
  that reject it (e.g. Windows). Treat this as: **readers never observe
  mixed/partial state; crash durability of a completed publish is
  best-effort, not guaranteed on every filesystem or across power loss.**

## Attribution

- US government domain data © CISA dotgov-data, released under
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- ROR data © Research Organization Registry, released under
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). ROR location
  data derives from GeoNames (CC-BY-4.0); this registry does **not** consume or
  reproduce location fields.
