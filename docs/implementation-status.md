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

## Current implementation stage

Stage 3 — Hiscores investigation, result model, parser fixtures, and the
centralized Hiscores client.

The implementation must verify the Jagex Old School Hiscores endpoint strategy
and mode-verification matrix before account or snapshot work can be considered
complete.

The merged Stage 3 foundation implements the OSRS-only endpoint and
mode-verification contract, typed result model, current named skill and boss
catalogue, sanitized fixture, deterministic JSON parser, centralized HTTP
transport, and focused controlled-server tests. The current unmerged branch
adds the bounded successful-response cache and fresh-fetch bypass. Account
registration validation orchestration and snapshot persistence remain outside
the branch.

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

`1cc93e8` (2026-07-24) — Merge OSRS Hiscores HTTP transport.

This merged encoded request construction, typed HTTP and timeout results, one
bounded retry for temporary failures, a small concurrency limiter, and
controlled local-server tests into the centralized Hiscores client.

Documentation-only maintenance commits may be newer; Git history remains the
authority for the latest repository change.

## Next recommended branch-sized task

After the successful-response cache is reviewed and merged, continue Stage 3
with account-registration validation orchestration. It should select the
verified endpoint strategy for each account mode, apply the required
Hardcore/Ultimate exclusion before accepting regular Ironman, and preserve
the server-managed label contract for Main and Group Ironman modes. Keep
database persistence and Discord registration interactions outside that
branch.
