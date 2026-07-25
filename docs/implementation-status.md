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

The merged account-renaming work adds successful Hiscores
validation using the stored account mode. It authorizes self-service renames
for linked members and watchlist registrants, plus account-manager renames. A
guild-scoped serialized update preserves the stable account ID, association,
default selection, quota attribution, and recap baseline while enforcing
normalized username uniqueness. Focused unit and PostgreSQL integration tests
cover authorization, validation failures, conflicts, guild isolation, and
preserved recap baselines.

The merged account-mode-change work adds successful Hiscores
validation against the selected mode and the account's stored username. It
authorizes linked-account owners and watchlist registrants, plus account
managers. A guild-scoped serialized update preserves the stable account ID,
association, default selection, quota attribution, and recap baseline. Focused
unit and PostgreSQL integration tests cover authorization, validation failures,
guild isolation, and preserved account data.

The merged account-association-conversion work authorizes watchlist-to-linked
conversion only for account managers, and linked-to-watchlist conversion for
the linked member or an account manager. Authorization, current association
state, quota enforcement, and the write are serialized in one guild-scoped
transaction. It preserves the stable account ID, registration metadata, and
recap baseline; it also assigns or replaces the member default account as
needed. Returning an account to watchlist restores quota attribution to its
original adder. Focused unit and PostgreSQL integration tests cover those
rules, including stale-ownership protection and guild isolation.

Stage 5 is not complete. It intentionally does not add Discord command wiring,
public announcements, administrative-channel delivery, removal,
linked-account reassignment, member-presence tracking, or the durable
daily-recap run, scheduling, and delivery work owned by later slices.

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

`86809d2` (2026-07-25) - Merge account mode changes.

This merged validated, authorized account-mode changes that preserve stable
account identity and recap baselines, with focused unit and PostgreSQL
integration coverage.

## Latest merged implementation work

`466bef8` (2026-07-25) - Merge account association conversion.

This merged authorized association conversion with atomic state,
authorization, quota, and default-account handling while preserving stable
account identity, registration metadata, and recap baselines.

Documentation-only maintenance commits may be newer; Git history remains the
authority for the latest repository change.

## Next recommended branch-sized task

Add manager-only linked-account reassignment. Keep Discord command wiring,
destructive removal confirmation, and active-competition restrictions out of
that focused branch.
