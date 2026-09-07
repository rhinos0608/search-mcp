# ADR-010: Narrow filesystem capability

**Status:** Approved

## Context

Default `$HOME` access exposes credentials and unrelated private data to model-facing ingestion.

## Decision

Accept trusted client roots and explicit configured grants only. Canonicalize, realpath, enforce containment, reject traversal/symlink escape, validate file identity/type/size, and parse in constrained disposable child processes; application capability reports network isolation as not enforced. HTTP path ingestion is off by default.

## Alternatives

Entire home directory as stdio default was rejected.

## Verification

Traversal, symlink, swapped-file, `/`, `$HOME`, and `.ssh` self-grants reject.
