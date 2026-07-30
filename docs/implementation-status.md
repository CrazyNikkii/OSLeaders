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

The merged linked-account-reassignment work adds
manager-only reassignment of a linked account to another member. The
guild-scoped serialized write enforces the destination quota, preserves stable
account identity, registration metadata, and the recap baseline, and repairs
the source and destination default selections. Focused unit and PostgreSQL
integration tests cover authorization, linked-account-only handling, guild
isolation, default transitions, baseline preservation, and concurrent quota
enforcement.

The merged member-presence work adds guild-scoped durable presence state keyed
by Discord user ID. Its Discord-independent Accounts service marks members
absent or present without deleting or unlinking their accounts. The PostgreSQL
upsert preserves one state per guild/member pair, and focused unit and
PostgreSQL integration tests cover departure, rejoin, guild isolation, schema
migration, and preservation of linked accounts and recap baselines.

The merged account-removal foundation authorizes linked-account
owners and watchlist registrants, plus account managers, to remove an account
within its guild. Its serialized PostgreSQL deletion repairs a removed linked
member's default account by selecting the oldest remaining linked account, and
the existing foreign-key cascade removes the daily-recap baseline. Focused unit
and PostgreSQL integration tests cover authorization, guild isolation, default
replacement, and baseline deletion. Active-competition guards remain deferred.

The merged Discord account-command foundation selects the
`/account` command group and adds its first Discord adapter slice:
guild-only `/account remove` registration with account autocomplete,
Discord Administrator and configured bot-manager permission inputs, and an
explicit removal-confirmation button backed by a one-time, guild- and
initiator-bound record with a five-minute expiry. The adapter delegates to the
existing guild-scoped account services; focused tests cover command definition,
guild isolation, authorization, confirmation binding and expiry, malformed
confirmation IDs, bounded cleanup, and Discord interaction translation. This
work is implemented and merged.

The unmerged `codex/discord-account-registration-flow` branch adds the next
Discord adapter slice: a guild- and initiator-bound guided `/account register`
flow. It collects the username in a modal, association through a select menu,
the linked member through a manager-only member picker when needed, and the
game mode through text-labelled Discord select-menu choices. Guild configuration
now persists optional per-mode Discord custom emojis through a reviewed
migration, and the mode menu renders them decoratively while retaining text
labels. The flow delegates validation, authorization, quota enforcement,
default selection, and atomic baseline creation to the existing registration
service. Focused unit tests cover the command definition, complete adapter
interaction chain, configured emoji rendering, self-service watchlist flow,
manager-linked flow, session binding, and expiry. This work is awaiting review
and must not be treated as merged.

Stage 5 is not complete. It does not yet add public announcements,
administrative-channel delivery, or the durable daily-recap run, scheduling,
and delivery work owned by later slices.

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

`79317dd` (2026-07-25) - Merge member-presence persistence.

This merged guild-scoped durable member presence state, allowing departures
and rejoins to be recorded without unlinking or deleting accounts.

## Latest merged implementation work

`9ebc57e` (2026-07-25) - Merge Discord account command foundation.

This merged the guild-only `/account remove` command foundation, including
account autocomplete, Discord permission inputs, expiring one-time removal
confirmation, bounded in-memory cleanup, and focused adapter tests.

Documentation-only maintenance commits may be newer; Git history remains the
authority for the latest repository change.

## Next recommended branch-sized task

After `codex/discord-account-registration-flow` is reviewed and merged, add
public registration-success announcements
(`codex/discord-account-registration-announcements`). Administrative-channel
delivery remains a separate adapter task.
