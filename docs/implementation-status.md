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
- Stage 6 - Lookups and permanent leaderboards for the approved
  slash-command-only v1 scope.
- Stage 7 - Daily recap configuration, collection, preview, durable delivery,
  and automatic scheduling. The configured Debian private beta has completed
  its operational acceptance and has run continuously without reported issues;
  backup and restore guarantees remain explicitly deferred for this small
  private beta.

## Current implementation stage

Stage 5 - Account-management Discord adapters. The account-mode adapter is the
current unmerged branch work. Daily recaps were intentionally delivered before
competitions so the bot could support the private beta first; Stage 8 remains
deferred while the narrower account-management slices are completed.

The merged skill-lookup foundation begins the lookup module with a
Discord-independent, guild-scoped skill lookup service. It resolves a
caller's default tracked account, an explicit tracked account, or a transient
one-time account, then fetches the selected account mode's Hiscores endpoint
through the centralized client's ordinary cache policy. It does not persist
one-time accounts. Focused unit tests cover target isolation, direct Ironman
endpoint fetching, Hiscores failures, and incomplete responses. This work is
merged as part of Stage 6.

The merged Discord skill-lookup adapter adds guild-only `/skill` with a
canonical Discord skill choice and optional guild-scoped tracked-account
autocomplete. It delegates target resolution and selected-mode Hiscores
fetching to the existing lookup service; without an account option it uses the
caller's default. Successful results are public embeds showing the account,
text mode label, level, experience, and rank, while expected failures are
private. Focused adapter, runtime-binding, and development-command
registration tests cover command definition, target isolation, presentation,
failure translation, and development-guild interaction wiring.

The merged Discord one-time skill-lookup adapter adds the
separate guild-only `/one-time-skill` guided flow. It collects a username in a
modal, then mode and canonical skill choices through an initiator- and
guild-bound five-minute session. It delegates only to the existing transient
lookup target, so no tracked account, quota, or recap baseline is persisted.
The flow and result remain private, while its found-result embed and failure
translation reuse the established skill-lookup presenter. Focused tests cover
the command, complete interaction chain, selected mode, session binding and
expiry, development command registration, and runtime wiring.

The merged skill-leaderboard foundation adds a Discord-independent, guild-scoped
service that fetches every tracked account through its stored mode's Hiscores
endpoint, returns successful level/XP entries sorted by experience, and keeps
per-account Hiscores or incomplete-response failures separate. It preserves
linked and watchlist accounts as individual entries. Focused unit tests cover
guild isolation, endpoint selection, deterministic ordering, partial failure,
incomplete results, and empty guilds.

The merged Discord skill-leaderboard adapter adds guild-only `/skill-leaderboard`
with canonical skill choices and top-10 or all-results selection. It renders
public ranked level/XP entries with text mode labels, linked-owner or watchlist
markers, and a distinct unavailable-accounts section; long valid output is
split into numbered embeds and message batches. It delegates all fetching,
guild isolation, sorting, and partial-result handling to the merged service.

The merged boss-leaderboard foundation adds a Discord-independent,
guild-scoped service that fetches every tracked account through its stored
mode's Hiscores endpoint, ranks successful entries by boss kill count, omits
zero-KC entries when another successful entry has KC, and retains per-account
Hiscores or incomplete-response failures separately. Focused unit tests cover
guild isolation, endpoint selection, deterministic ordering, zero-KC handling,
partial failure, incomplete results, and empty guilds.

The merged Discord boss-leaderboard adapter adds guild-only
`/boss-leaderboard` with canonical boss autocomplete and top-10 or all-results
selection. It renders
public ranked KC entries with text mode labels, linked-owner or watchlist
markers, and a distinct unavailable-accounts section; long valid output is
split into numbered embeds and message batches. It delegates all fetching,
guild isolation, ranking, zero-KC handling, and partial-result handling to the
merged service.

The merged boss-lookup foundation adds a Discord-independent, guild-scoped
service for a selected boss activity. It resolves a caller's default tracked
account, an explicit tracked account, or a transient one-time account, then
fetches the selected account mode's Hiscores endpoint through the centralized
client. It preserves resolved targets for Hiscores failures and incomplete
responses, and it never persists one-time accounts. Focused unit tests cover
default, guild-scoped explicit, and one-time targets; stored-mode endpoint
selection; failures; and incomplete responses.

The merged Discord boss-lookup adapter adds guild-only `/boss` with canonical
boss autocomplete and optional guild-scoped tracked-account autocomplete. It
uses the caller's default account when no account is selected, presents found
KC, rank, and text mode-label results publicly, and keeps expected failures
private. It acknowledges slow Hiscores work privately before posting successful
results directly to the guild channel, then removes the private acknowledgement.
If public delivery fails, it gives the requester a private retry message and
reports the delivery failure. It delegates target isolation and Hiscores
handling to the merged boss-lookup service. Focused adapter, slow-lookup, and
delivery-failure tests cover these behaviours.

The merged Discord one-time boss-lookup adapter adds the separate guild-only
`/one-time-boss` guided flow. It collects a username in a modal, then game mode
and canonical boss choices through an initiator- and guild-bound five-minute
session. Boss choices are grouped into bounded alphabetical menus, ordered as
though a leading `The` were absent while retaining their displayed names. It
uses only the existing transient boss-lookup target, so no tracked account,
quota, or recap baseline is persisted. The guided flow stays private, while a
successful result is published in the invoking guild channel and the private
controls are removed. Focused session, interaction, public-delivery, and
development-runtime wiring tests cover the flow.

Prefix-command convenience work, including `!` commands and Message Content
intent, is explicitly deferred until after v1. With that scope decision, the
merged slash-command lookup and leaderboard slices complete Stage 6.

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

The merged Discord account-registration flow adds the next Discord adapter
slice: a guild- and initiator-bound guided `/account register`
flow. It collects the username in a modal, association through a select menu,
the linked member through a manager-only member picker when needed, and the
game mode through text-labelled Discord select-menu choices. Guild configuration
now persists optional per-mode Discord custom emojis through a reviewed
migration, and the mode menu renders them decoratively while retaining text
labels. The flow delegates validation, authorization, quota enforcement,
default selection, and atomic baseline creation to the existing registration
service. Focused unit tests cover the command definition, complete adapter
interaction chain, configured emoji rendering, self-service watchlist flow,
manager-linked flow, session binding, and expiry. This work is implemented and
merged.

The merged public registration-success announcement work adds delivery to the
invoking guild channel after the account registration service reports success.
The guided interaction and unsuccessful registration results remain ephemeral.
If Discord cannot publish the announcement, the completed registration remains
valid and the initiator receives a private delivery-failure notice. Focused
adapter tests cover success, unsuccessful registrations, delivery failures, and
the concrete channel publisher.

The merged registration administrative-log work adds registration
delivery to the configured administrative log channel. It resolves the
configuration and channel within the invoking guild, applies the existing
Standard/Verbose audit-delivery policy, and sends only the fixed registration
summary. Registration-enabled adapter construction requires this publisher, and
the provided composition factory wires it from guild configuration. Missing
configuration and Discord delivery failures do not undo a completed registration
or its public announcement. Focused adapter tests cover configured and
unconfigured delivery, guild-scoped channel resolution, required wiring, and
the completed registration flow.

The merged Discord default-account selection work adds guild-only
`/account default` with linked-account autocomplete. It delegates selection and
authorization to the existing Discord-independent default-account service,
limits normal users to their own linked accounts, and permits account managers
to select a linked account for another member. The required handler wiring
prevents the registered command from becoming unavailable at interaction time.
Focused adapter tests cover command registration, selection, authorization,
guild isolation, autocomplete, response translation, and factory construction.

Stage 5 is not complete. The remaining deferred account-management Discord
adapters remain post-launch priorities.

The remaining Discord adapters for account-association conversion and
linked-account reassignment remain deliberately deferred until post-launch use
demonstrates a need. Their Discord-independent services are merged and remain
available; this is an implementation-priority decision, not a removal of the
approved product behaviour.

The merged development Discord runtime foundation adds explicit development-guild
command registration and a runnable local bot composition for the merged
`/account register`, `/account remove`, and `/account default` adapter slices.
It validates development-only runtime configuration, checks PostgreSQL
connectivity before logging into Discord, wires the concrete PostgreSQL,
Hiscores, permission, configuration, and account-adapter dependencies, and
closes Discord and PostgreSQL on shutdown. It ignores interactions outside the
configured development guild. Focused tests cover development-guild
registration, startup guards, PostgreSQL and Discord login failure cleanup,
interaction filtering, idempotent shutdown, and sanitized interaction-failure
diagnostics. A manual Discord checklist documents the current real-world
vertical-slice tests.

The merged Discord account-renaming flow adds guild-only `/account rename`
with permission-scoped autocomplete and a username modal. It delegates to the
existing account-renaming service for authorization and stored-mode Hiscores
validation, keeps successful responses ephemeral, and wires the handler into
the development runtime. Successful renames create structured, sanitized
`account.rename` audit events with account-change and actor context for local
logging, then deliver rendered summaries to the configured administrative log
channel without undoing a valid rename if delivery fails. Focused unit tests
cover the command definition, authorization, guild isolation, modal handling,
audit context, audit delivery, and delivery failure.

## Deferred and later planned stages

- Stage 5 - Remaining deferred account-management Discord adapters.
- Post-v1 - Prefix-command convenience interface, including any prefix
  configuration, Message Content intent, aliases, and free-text parsing.
- Stage 8 - Competition lifecycle, snapshots, claims, scheduling, roles, and
  history.
- Stage 9 - Full acceptance, failure-recovery, resource, and deployment
  testing.
- Future production-readiness - External backups, restore rehearsal, and
  retention policy if the product is prepared for public distribution, paid
  use, or a larger community.

## Previous merged implementation work

`f004213` (2026-07-30) - Merge Discord one-time skill lookup command.

This merged the separate guild-only `/one-time-skill` flow, including a
username modal, canonical game-mode and skill choices, five-minute
guild-and-initiator-bound sessions, transient Hiscores lookup, private results,
development command/runtime wiring, documentation, and focused tests.

`e3a9722` (2026-07-30) - Merge skill leaderboard foundation.

This merged the Discord-independent guild skill-leaderboard service. It fetches
each tracked account through its stored-mode Hiscores endpoint, sorts successful
entries by XP with deterministic tie-breakers, and retains per-account failures
without discarding successful results.

## Latest merged implementation work

`4ae4d79` (2026-08-07) - Merge account mode command.

This merged the guild-only `/account mode` flow. Authorized account owners and
account managers can select a corrected stored game mode; OSLeaders validates
the selected mode before saving it, keeps the response private, and records
the successful edit through the administrative-log policy.

`9967972` (2026-08-07) - Merge private-beta backup deferral.

This recorded the approved decision that the small private beta may continue
without backup or restore guarantees. The operational assets remain retained
for a future public, paid, or larger-community deployment.

`6bca34d` (2026-08-05) - Merge boss selection coverage fix.

This merged the `/boss` bounded-menu fix. Boss choices are now shared with the
one-time boss flow, retain their names while sorting without a leading `The `,
and are available through bounded alphabetical select menus. `/boss` selection
sessions are limited to five minutes and bound to the initiating user and guild.

`664b9c8` (2026-08-05) - Record recap configuration fix merge.

This merged the status-record correction for the recap configuration acknowledgement
fix after its pull request was merged.

`b3b9ee9` (2026-08-05) - Merge recap configuration acknowledgement fix.

This merged the private Discord acknowledgement fix for `/recap configure`:
the adapter now defers before configuration or database work and edits that
private response with configured, forbidden, or validation outcomes. It also
corrected the Windows private-beta CI job to install locked dependencies and
run the existing Debian operational-assets test.

`6fa38a5` (2026-08-05) - Add private beta laptop readiness.

This merged the initial Windows single-server private-beta operating path. Its
Windows runtime and backup assets are superseded by the merged Debian
deployment path below; Windows remains the development environment.

Documentation-only maintenance commits may be newer; Git history remains the
authority for the latest repository change.

`ff398d9` (2026-08-05) - Merge Debian private-beta readiness.

This merged the Debian 13 headless-SSH operating path: separate production
Discord and database configuration, guarded production migrations, systemd
runtime and backup-timer units, protected unattended PostgreSQL credentials,
and Debian backup, restore-rehearsal, and acceptance guidance.

## Current unmerged implementation work

None.

## Next recommended branch-sized task

Select the smallest observed account-management need between the
association-conversion and linked-account-reassignment Discord adapters before
beginning Stage 8 competitions.
