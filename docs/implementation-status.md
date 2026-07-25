# Implementation status

This document is the repository's current implementation record. It must be
verified against the checked-out code and Git history before it is relied on or
updated. A stage is complete only when its approved scope is implemented and
merged.

## Completed stages

- Stage 1 - Project skeleton, locked dependencies, centralized runtime
  configuration validation, code-quality tools, and test harness.
- Stage 2 - PostgreSQL connection and migration foundation, guild tenancy-root
  schema, and guarded PostgreSQL integration-test safety.
- Stage 3 - Hiscores investigation, result model, parser fixtures, centralized
  HTTP client, bounded success cache, and account-mode validation.
- Stage 4 - Guild configuration, Discord-independent permissions, structured
  audit events, central sanitization, error-reference IDs, administrative-log
  policy selection, and local structured logging.

## Current implementation stage

Stage 5 - Account registration and management.

The current branch adds the first Stage 5 account-registration foundation: a
guild-scoped tracked-account schema and reviewed migration; stable account IDs;
normalized username uniqueness per guild; linked and watchlist associations;
quota attribution; and serialized PostgreSQL registration writes that preserve
the ten-account quota and select the first linked account as default. The
Discord-independent registration service authorizes self-service versus account
manager registrations and persists only after successful Hiscores mode
validation. The validated complete Hiscores result is transformed into the
first rolling recap baseline and inserted in the same database transaction as
the account. Focused unit and PostgreSQL integration tests cover these rules,
including concurrent quota and first-default races.

This work is not yet merged, so Stage 5 is not complete. It intentionally does
not add Discord command wiring, public announcements, administrative-channel
delivery, account editing/removal/conversion, or the durable daily-recap
run, scheduling, and delivery work owned by later slices.

## Later planned stages

- Stage 5 - Account registration and management.
- Stage 6 - Lookups and permanent leaderboards.
- Stage 7 - Competition lifecycle, snapshots, claims, scheduling, roles, and
  history.
- Stage 8 - Recap baselines, preview, durable send, automatic scheduling, and
  active competition summaries.
- Stage 9 - Full acceptance, failure-recovery, resource, and deployment
  testing.
- Stage 10 - Deployment and backup specification based on the actual laptop.

## Previous merged implementation work

`dafbf7b` (2026-07-24) - Merge permission-evaluation foundation.

This merged Discord-independent application-level permission evaluation for
account and competition management, based on Discord Administrator permission
and the requesting guild's configured manager-role IDs.

## Latest merged implementation work

`4a8ec99` (2026-07-25) - Merge audit and local logging foundation.

This merged structured audit events, central sanitization, error-reference IDs,
administrative-log policy selection, and failure-tolerant local structured
logging, completing Stage 4.

Documentation-only maintenance commits may be newer; Git history remains the
authority for the latest repository change.

## Next recommended branch-sized task

After the current account-registration foundation is reviewed and merged, add
account retrieval and default-account selection/change operations. Keep
Discord command wiring, destructive removal confirmation, and active-
competition restrictions out of that focused branch.
