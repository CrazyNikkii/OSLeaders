# Implementation status

This document is the repository's current implementation record. It must be
verified against the checked-out code and Git history before it is relied on or
updated. A stage is complete only when its approved scope is implemented and
merged.

## Completed stages

- Stage 1 — Project skeleton, locked dependencies, centralized runtime
  configuration validation, code-quality tools, and test harness.
- Stage 2 — PostgreSQL connection and migration foundation, guild tenancy-root
  schema, and guarded PostgreSQL integration-test safety.

## Next planned stage

Stage 3 — Hiscores investigation, result model, parser fixtures, and the
centralized Hiscores client.

The implementation must verify the Jagex Old School Hiscores endpoint strategy
and mode-verification matrix before account or snapshot work can be considered
complete.

## Later planned stages

- Stage 4 — Guild configuration, permissions, and audit foundations.
- Stage 5 — Account registration and management.
- Stage 6 — Lookups and permanent leaderboards.
- Stage 7 — Competition lifecycle, snapshots, claims, scheduling, roles, and
  history.
- Stage 8 — Recap baselines, preview, durable send, automatic scheduling, and
  active competition summaries.
- Stage 9 — Full acceptance, failure-recovery, resource, and deployment
  testing.
- Stage 10 — Deployment and backup specification based on the actual laptop.

## Latest merged implementation work

`83d9bc6` (2026-07-24) — Add runtime configuration validation.

This added centralized typed runtime configuration for Discord, PostgreSQL,
runtime environment and log settings; guarded environment-file precedence;
placeholder and unsafe-value rejection; focused tests; and stricter local
PostgreSQL URL validation.

Documentation-only maintenance commits may be newer; Git history remains the
authority for the latest repository change.

## Next recommended branch-sized task

Begin Stage 3 with the Hiscores contract and parser foundation: record the
verified endpoint and mode-verification matrix, define the typed result model,
add sanitized response fixtures, and implement deterministic parser tests.
Keep HTTP transport, caching, retries, account registration, and snapshot
persistence outside that branch.
