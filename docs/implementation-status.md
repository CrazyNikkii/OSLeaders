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

The merged account-registration foundation provides a
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

The merged account retrieval and default-account selection/change work keeps
retrieval guild-scoped, supports default resolution for a linked member, and
serializes a default change so a member retains one linked default account.
Application-level authorization allows self-service selection or
account-manager selection for another member, while watchlist and cross-guild
accounts cannot become defaults. Focused unit and PostgreSQL integration tests
cover those rules.

The current unmerged branch adds account renaming with successful Hiscores
validation using the stored account mode. It authorizes self-service renames
for linked members and watchlist registrants, plus account-manager renames. A
guild-scoped serialized update preserves the stable account ID, association,
default selection, quota attribution, and recap baseline while enforcing
normalized username uniqueness. Focused unit and PostgreSQL integration tests
cover authorization, validation failures, conflicts, guild isolation, and
preserved recap baselines.

Stage 5 is not complete. It intentionally does not add Discord command wiring,
public announcements, administrative-channel delivery, account-mode changes,
removal, conversion, member-presence tracking, or the durable daily-recap run,
scheduling, and delivery work owned by later slices.

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

`f47f6d3` (2026-07-25) - Merge account registration foundation.

This merged the Stage 5 tracked-account and recap-baseline schema, validated
registration service, quota/default serialization, and focused unit and
PostgreSQL integration coverage.

## Latest merged implementation work

`5486bd6` (2026-07-25) - Merge account retrieval and default selection.

This merged guild-scoped account retrieval and atomic default-account
selection, including application-level authorization and focused unit and
PostgreSQL integration coverage.

Documentation-only maintenance commits may be newer; Git history remains the
authority for the latest repository change.

## Next recommended branch-sized task

After the current account-renaming branch is reviewed and merged, add
account-mode changes with successful Hiscores validation. Keep Discord command
wiring, destructive removal confirmation, conversion, and active-competition
restrictions out of that focused branch.
