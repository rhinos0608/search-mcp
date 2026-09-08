# ADR-023: Evaluation target and gate applicability

## Status

Superseded by ADR-026

## Context

The product-completion path is not a legacy cutover. Durable profile persistence is inactive and request-scoped profiles are nonpersistent by design.

## Decision

Quality gates declare `applicability` as `applicable` or `not_applicable`; missing applicability fails closed as applicable. Inactive profile persistence is not applicable only with positive evidence of no production profile-store wiring or write action, request-scoped use, `zeroPersistence: true`, and `reusableHandle: false`. Success-rate, integrity, policy, and metrics gates remain applicable. Activation remains blocked until ADR-019 key, encryption, and deletion controls are satisfied.

## Consequences

Product completion may report shadow-capable/cutover-blocked while retaining legacy behavior. No semantic_jobs redirect or cutover is implied.
