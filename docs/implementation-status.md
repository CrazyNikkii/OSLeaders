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

The merged Stage 3 parser foundation implements the OSRS-only endpoint and
mode-verification contract, typed result model, current named skill and boss
catalogue, sanitized fixture, deterministic JSON parser, and focused parser
tests. The current unmerged branch adds the centralized HTTP transport:
encoded request construction, typed HTTP and timeout results, one bounded
retry for temporary failures, a small concurrency limiter, and controlled
local-server tests. Caching, account-registration validation orchestration,
and snapshot persistence remain outside the branch.

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

`e6448e6` (2026-07-24) — Merge OSRS Hiscores contract parser.

This merged the verified OSRS endpoint and mode-verification contract, typed
Hiscores result model, current named skill and boss catalogue, sanitized
response fixture, deterministic parser, and focused parser tests.

Documentation-only maintenance commits may be newer; Git history remains the
authority for the latest repository change.

## Next recommended branch-sized task

After the centralized HTTP transport is reviewed and merged, continue Stage 3
with a bounded one-minute successful-response cache and a fresh-fetch bypass
for snapshot-changing callers. Include cache-key, expiry, maximum-entry, and
controlled-server tests; keep account registration and snapshot persistence
outside that branch.
