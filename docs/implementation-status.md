# Implementation status

This document is the repository's current implementation record. It must be
verified against the checked-out code and Git history before it is relied on or
updated. A stage is complete only when its approved scope is implemented and
merged.

## Merged implementation foundations

- Stage 1 has the project skeleton, locked dependencies, code-quality tools,
  and test harness merged. Centralized runtime configuration validation is not
  yet merged, so Stage 1 is not recorded as complete.
- Stage 2 has the PostgreSQL connection and migration foundation, guild
  tenancy-root schema, and guarded PostgreSQL integration-test safety merged.

## Current implementation work

The current branch completes Stage 1's centralized runtime configuration
validation. This work remains pending until it is reviewed, committed, and
merged.

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

## Latest merged work

`639ebf5` (2026-07-24) — Document implementation progress requirements.

This is the latest merged repository change. It added this implementation
status record and the progress-maintenance requirements in `AGENTS.md`.

The latest merged implementation change is `56bd401` (2026-07-24) — Add
PostgreSQL database foundation.

This added the initial `guilds` tenancy-root migration, Drizzle migration
configuration and metadata, guarded separate-test-database reset and migration
commands, PostgreSQL connection configuration, integration tests, and CI
coverage for the complete check set.

## Next recommended branch-sized task

Finish review and merge the current Stage 1 runtime-configuration work. After
that merges, begin Stage 3 with the Hiscores contract and parser foundation:
record the verified endpoint and mode-verification matrix, define the typed
result model, add sanitized response fixtures, and implement deterministic
parser tests. Keep HTTP transport, caching, retries, account registration, and
snapshot persistence outside that branch.
