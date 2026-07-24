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
- Stage 3 — Hiscores investigation, result model, parser fixtures, centralized
  HTTP client, bounded success cache, and account-mode validation.

## Current implementation stage

Stage 4 — Guild configuration, permissions, and audit foundations.

The current unmerged branch establishes the guild-configuration persistence and
service foundation: one configuration record per guild, configured manager-role
and administrative-log channel IDs, Standard or Verbose audit-log mode, and
guild-isolation coverage. It intentionally does not add Discord command wiring,
permission evaluation, audit delivery, or the remaining guild settings owned by
later feature slices.

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

## Previous merged implementation work

`807b2e9` (2026-07-24) — Merge Hiscores success cache.

This merged a bounded, one-minute successful-response cache with normalized
username and endpoint keys, least-recently-used eviction, and a fresh-fetch
bypass into the centralized Hiscores client.

## Latest merged implementation work

`3815eaf` (2026-07-24) — Merge account-mode validation.

This merged validation coordination for the approved endpoint strategy,
including the required Hardcore and Ultimate exclusions before regular Ironman
is accepted. With the prior contract, parser, transport, and cache work, it
completed Stage 3.

Documentation-only maintenance commits may be newer; Git history remains the
authority for the latest repository change.

## Next recommended branch-sized task

After the current guild-configuration foundation branch is reviewed and merged,
continue Stage 4 with application-level permission evaluation. It should use
the configured manager-role IDs and Discord Administrator input through a
Discord-independent authorization request model, without Discord command
wiring. Follow with structured audit and local logging foundations as a
separate branch-sized task.
