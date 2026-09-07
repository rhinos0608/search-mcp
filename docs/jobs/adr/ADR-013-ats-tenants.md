# ADR-013: Configured ATS tenant registry

**Status:** Approved

## Context

Public-looking ATS endpoints vary by tenant, policy, and abuse surface.

## Decision

Use operator-installed configured tenants and contract-test each tenant. Arbitrary caller-provided ATS hosts cannot select fetch targets.

## Alternatives

Arbitrary ATS hosts were rejected for SSRF, request explosion, and policy uncertainty.

## Verification

Unknown tenants and policy-blocked tenants produce no adapter request.
