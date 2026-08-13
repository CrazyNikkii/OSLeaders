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

Stage 8 - Competition draft creation, participation, start foundation, and
manual-start adapter. The merged Discord-independent target-race claim
foundation durably records a stable claim ID and UTC receipt time before
cache-bypassing Hiscores verification, combines immutable per-account starting
snapshots, and finalizes the earliest verified claim deterministically. The
merged guild-only `/competition claim` adapter adds bounded,
initiator- and guild-bound selection of eligible active target-race entrants;
it acknowledges before verification, keeps unsuccessful outcomes private,
publishes verified wins publicly, and delegates
authorization, receipt ordering, verification, retry, and winner selection to
the merged service. The merged target-race finish foundation atomically records
the verified winning claim and transitions its competition from `active` to
`finished`, retaining the claim's final value and immutable historical
snapshots. The merged optional-deadline target-race finalization workflow claims
due work, waits for pending on-time claims, collects cache-bypassing final
values, persists shared exact-tie winners, and retries failed collection.
The merged active-competition recap summary adds the required compact section
to daily recaps. It reuses the guild-scoped standings read model, shows up to
three ranked entrants per active competition, preserves incomplete-score
context, and treats unavailable competition data as an optional warning so
recap collection, baseline advancement, and durable delivery remain successful.
The merged
Discord-independent competition standings
foundation adds active-competition progress collection with durable last-known
values for partial Hiscores failures, combined linked-account scores, standalone
watchlist entrants, shared ranks, and incomplete-score warnings. The merged
guild-only `/competition standings` adapter exposes those results through
bounded active-competition selection to any server member, acknowledges before
Hiscores collection, and publishes public embeds with score, account breakdown,
rank, deadline or target, and stale-account context. The
merged `/account mode` adapter, member-presence Discord event work, daily-recap
readability improvements, `/competition create` flow, and guild-only Discord
draft-participation adapter complete the current edit, presence,
recap-presentation, competition-draft creation, and draft-participation
workflows. The merged Discord-independent competition-start foundation adds
authorized manual start from a draft, durable per-account historical
starting-value snapshots, durable actual start/deadline timestamps, and the
`start_pending` retry path for incomplete initial Hiscores fetches. The merged
scheduled-start foundation adds a durable intended UTC start instant and
timezone-aware local-time validation, then lets the existing constrained retry
scheduler atomically claim due drafts into the durable start workflow. The
raid-menu update separates the six supported raid activities into a dedicated
shared Discord selector, while all other supported bosses remain in bounded
alphabetical selectors. That shared selector serves boss lookups, one-time
boss lookups, boss leaderboards, and competition creation; it does not alter
leaderboard collection or the remaining competition lifecycle work.

`fdc8e68` (2026-08-11) merged the competition cancellation lifecycle. Creator
or competition-manager authorized cancellation durably moves draft,
start-pending, active, and finish-pending competitions to `cancelled`, clears
start and finish retry state, and prevents schedulers from resuming the prior
lifecycle. The guild-only `/competition cancel` flow uses bounded,
initiator- and guild-bound selection plus explicit confirmation. Cancelled
competitions remain in history, use the existing durable configured-channel
delivery path, and trigger temporary-role cleanup recovery.

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
replacement, and baseline deletion. The subsequently merged active-competition
guards block deletion while a contribution is active or awaits final-value
collection.

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

The remaining Discord adapter for account-association conversion remains
deliberately deferred until post-launch use demonstrates a need. Its
Discord-independent service is merged and remains available; this is an
implementation-priority decision, not a removal of the approved product
behaviour. A Discord adapter for linked-account reassignment is not planned:
the existing Discord-independent service remains available for future review,
but it is not a private-beta or v1 implementation priority.

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

The merged member-presence Discord event work adds the runtime
adapter for the already-merged guild-scoped presence service. It handles member
joins and departures only for the configured guild, writes the durable present
or absent state without modifying accounts, and serializes transitions per
guild/member so a rejoin cannot be overwritten by an older departure write. It
reports unexpected persistence failures through sanitized local diagnostics,
enables the required Discord Guild Members gateway intent, documents the
Developer Portal setting, and adds focused adapter and runtime-binding tests.
Focused adapter and runtime-binding tests cover this work.

The merged daily-recap readability improvements remove the technical
account-specific-baselines caption from public and preview recap summaries. It
renders one boss or skill gain per line, gives positive level gains their own
native Discord blockquote, and separates player blocks with a literal text
divider. The compact totals remain unchanged, and each account continues to be
measured against its own durable rolling baseline without exposing that
implementation detail to Discord users. Focused unit tests cover the caption's
absence and the readable delivery and preview layout.

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

`dc2e77b` (2026-08-13) - Merge finished-competition account deletion.

This merged the guild-scoped terminal-history deletion rule. An account retained
only by `finished` or `cancelled` competition history can now be removed while
its immutable historical entrant, contribution, snapshot, and result facts are
preserved. Deletion remains blocked for every non-terminal competition state.

`50671e3` (2026-08-12) - Merge active-competition account-mutation guards.

This merged guild-scoped transactional guards that block deletion, game-mode
changes, and association conversion for accounts contributing to `active` or
`finish_pending` competitions. It also blocks normal self-service renames while
retaining the validated, administrator-authorized genuine-RSN rename path and
its administrative audit event.

`31b4601` (2026-08-12) - Merge active competition recap summaries.

This merged the required compact active-competition section into automatic and
manual daily recaps. It reuses guild-scoped standings, shows up to three ranked
entrants per active competition, preserves incomplete-score context, and makes
competition-summary failures optional so recap collection, baseline advancement,
and durable delivery remain successful.

`57b1736` (2026-08-12) - Merge competition cancellation recovery audit.

This merged focused cancellation-recovery acceptance coverage. Failed
cancelled-result delivery remains retryable, failed temporary-role cleanup
remains retryable, and optional audit logging cannot make a durable
cancellation fail.

`fdc8e68` (2026-08-11) - Merge competition cancellation lifecycle.

This merged the Stage 8 cancellation foundation and guild-only
`/competition cancel` flow. It durably transitions draft, start-pending,
active, and finish-pending competitions after creator-or-manager
authorization, clears lifecycle retry work, retains cancelled history, and
uses existing durable result delivery and role cleanup recovery.

`65dc3d6` (2026-08-11) - Merge competition role lifecycle.

This merged durable, guild-scoped temporary competition-role state. New and
migrated competitions receive an optional role record; constrained startup and
periodic recovery create, assign, synchronize, and clean up roles only after
the owning competition state is durable. Watchlist entrants and absent members
are excluded, draft departures lose the role, and completion removes members
before deleting the role. Deterministic per-competition role names let recovery
adopt a role created before its ID was persisted rather than creating a
duplicate. Discord permission failures warn the creator, emit a structured
role-management audit event, and retain retry state. Finished-result delivery
mentions the temporary role only on its first attempt.

`90c7876` (2026-08-11) - Merge competition result delivery recovery.

This merged the separately configured guild competition channel and durable
automatic finished-competition result delivery. It adds
`/competition configure-channel`, reviewed guild-scoped at-least-once delivery
records, split-safe result publishing, and startup plus periodic recovery.
Each delivery stores its selected channel before Discord is called, tracks
attempts and failures, and safely retries a stale in-progress attempt after a
process interruption.

`8c2fe90` (2026-08-11) - Merge competition results history.

This merged the guild-only `/competition history` flow for finished
competitions. It adds a Discord-independent immutable results read model and
PostgreSQL repository, bounded guild- and initiator-bound selection, and
public split-safe result embeds. It reads stored starting and final values,
winner records, completion time, and delayed-result status without a new
migration. It also corrects direct target-race completion to persist its
verified per-account final values, winner record, and completion timestamp,
matching the existing timed and deadline-finalization paths.

`fcf04b1` (2026-08-11) - Fix daily recap overall XP totals.

This merged correction makes every-account recap totals add only the displayed
positive XP gains. It preserves the established display threshold and does not
alter baseline collection, delivery, or competition work.

`1482a9c` (2026-08-11) - Merge timed competition finalization.

This merged the Discord-independent durable automatic finalization workflow for
timed most-XP and most-KC competitions. It claims due work, fetches final
values without the cache, retains final values and shared exact-tie winners,
records delayed results when collection happens after the stored deadline, and
retries failed collection through the existing in-process scheduler pattern. It
does not add Discord result presentation, roles, recap integration, or manual
finalization.

`1a3029d` (2026-08-11) - Merge target race deadline finalization.

This merged the Discord-independent durable finalization workflow for optional
target-race deadlines. It claims due fallback work, retries pending on-time
claims before selecting the most-progress winners, fetches fresh final values,
retains exact shared ties and final snapshots, and schedules restrained retries
after failures. It does not add result presentation, roles, recap integration,
or general timed-competition finalization.

`86e393e` (2026-08-10) - Add optional target race deadlines.

This is on `master` and permits target-race drafts to keep no deadline or
store a validated positive duration. It persists that choice through a
reviewed migration, collects the optional duration in the guided Discord
creation flow, and derives `endsAt` from the successful starting snapshot.

`a78e626` (2026-08-10) - Merge target-race finish foundation.

This merged the Discord-independent target-race finish foundation. When the
earliest valid claim wins, it atomically preserves the verified claim and final
value, records the winner, and transitions the competition from `active` to
`finished`. It does not add roles, recap integration, target-race deadline
completion with its most-progress fallback, or timed-competition finalization.

`472e18b` (2026-08-10) - Add Discord target-race claim command.

This merged the guild-only `/competition claim` adapter. It shows only
claimable active target-race entrants through bounded, initiator- and
guild-bound interactions, acknowledges before fresh Hiscores verification,
keeps unsuccessful outcomes private, publishes verified wins publicly, and
exposes a short-lived retry control for temporary verification failures. It
does not add roles, recap integration, or the broader finish lifecycle.

`d3a373e` (2026-08-10) - Merge target-race claim foundation.

This merged the Discord-independent, guild-scoped target-race claim foundation.
It persists a stable claim receipt before cache-bypassing Hiscores verification,
calculates combined gains from immutable starting snapshots, preserves pending
temporary failures for retry with their original receipt time, and deterministically
chooses the earliest verified valid claim. It does not add a Discord claim
adapter, roles, recap integration, or the broader finish lifecycle.

`5672905` (2026-08-10) - Merge Discord competition standings command.

This merged the guild-only `/competition standings` adapter. Any server member
can select an active competition through a bounded, guild- and initiator-bound
menu; the interaction is acknowledged before standings collection. The adapter
publishes public embeds with combined entrant scores, contributing-account
breakdowns, shared ranks, deadline or target context, and durable last-known
value warnings for incomplete entries. It does not add claims, roles, recap
integration, or finish lifecycle work.

`b533050` (2026-08-10) - Merge competition standings foundation.

This merged the Discord-independent, guild-scoped active-competition standings
foundation. It persists successful account observations separately from immutable
start snapshots, retains durable last-known values when Hiscores requests fail,
sums linked contributing accounts by Discord entrant, keeps watchlist entrants
standalone, assigns shared ranks for equal gains, and marks only affected entrants
as potentially incomplete. It does not add a Discord standings command, claims,
roles, recap integration, or finish lifecycle work.

`3c26386` (2026-08-10) - Merge Discord competition scheduling command.

This merged the guild-only `/competition schedule` adapter for draft
competitions. It presents bounded, initiator- and guild-bound selection,
collects a minute-precision local time through a modal, delegates
authorization and draft-state enforcement to the Discord-independent
scheduling service, and confirms the persisted UTC instant with Discord-native
timestamps. Focused unit, Discord adapter, runtime-binding, and PostgreSQL
integration coverage is merged with this work.

`21c8647` (2026-08-10) - Merge scheduled competition-start foundation.

This merged the durable optional intended-start instant for a competition, its
reviewed generated migration, and a timezone-aware minute-precision local-time
resolver that rejects daylight-saving gaps and ambiguous local times. The
existing constrained competition-start retry scheduler now also atomically
claims due scheduled drafts, changes them to `START_PENDING`, and invokes the
existing fresh-snapshot start workflow. Empty scheduled drafts remain drafts
and are retried later rather than being activated without entrants. It does not
add a Discord scheduling command, claims, standings, roles, or finish
lifecycle work. Focused unit and PostgreSQL integration tests cover UTC
resolution, invalid and DST local times, persisted intended starts, one-time
due claiming, empty-draft handling, and the durable transition.

`06ecd6a` (2026-08-10) - Merge pending competition start retries.

This merged the durable `START_PENDING` competition-start retry and
administrative-audit slice. Competition starts now persist attempt count, next
due time, and a sanitized failure summary. A constrained in-process scheduler
claims due starts at startup and at a restrained interval; an initial start
attempt writes a durable lease before Hiscores work so an interrupted process
can recover it. Failed starts retry once after a short delay and then at
ten-minute intervals, while successful starts clear retry state. Failure audit
events and optional administrative-channel summaries do not interrupt the
durable retry path. Focused unit, runtime, and PostgreSQL integration coverage
is merged with this work.

`ecfa4d9` (2026-08-10) - Merge raid boss menu.

This merged the shared Discord boss selector's dedicated Raids menu for the
six currently supported raid activities. The remaining bosses stay in bounded
alphabetical menus, with coverage for boss lookup, one-time boss lookup, boss
leaderboard, and competition creation. The catalog procedure now records that
future supported raids must be added to this menu as well as the boss catalog.

`4969e91` (2026-08-10) - Merge Mad Angel boss support.

This merged Jagex's `Mad Angel` activity into the central boss catalog and
representative Hiscores fixture, making it available through the parser, shared
Discord menus, lookups, leaderboards, competition metrics, and daily recaps.
It also safely repairs only the new field in legacy recap baselines, without
misreporting all-time KC as a daily gain.

`ee22d7b` (2026-08-10) - Merge boss leaderboard menu selection fix.

This merged the guild-only `/boss-leaderboard` correction to use the shared
bounded, alphabetically ordered boss select menus. The private selector stays
guild- and initiator-bound, acknowledges before leaderboard collection, and
publishes the selected leaderboard publicly with the chosen top-10 or all scope.

`9a6a9dc` (2026-08-10) - Merge Discord competition start command.

This merged the guild-only `/competition start` adapter for the durable start
foundation. It presents bounded, guild- and initiator-bound selection menus for
draft and `START_PENDING` competitions, acknowledges component interactions
before fresh Hiscores work, and privately presents `started` or `start_pending`
outcomes. It does not add automatic retry scheduling, claims, standings, roles,
or finish lifecycle work.

`bcb3540` (2026-08-10) - Merge competition start foundation.

This merged the Discord-independent, guild-scoped competition-start foundation.
Authorized manual starts transition drafts through durable `start_pending`,
fetch fresh cache-bypassing starting values outside the database transaction,
and atomically persist historical per-account snapshots with actual start and
deadline timestamps. Failed fetches retain `start_pending` so a later manual
retry can complete the start. It deliberately does not add a Discord start
command, scheduling, claims, standings, roles, or finish lifecycle work.

`8755b30` (2026-08-07) - Merge Discord competition draft participation.

This merged the guild-only Discord draft-participation adapter. It exposes
draft-only join, leave, creator-or-manager add, and creator-or-manager remove
through bounded, initiator- and guild-bound five-minute account-selection
interactions. It deliberately does not add snapshots, scheduling, claims,
standings, roles, or lifecycle transitions.

`ab3e01e` (2026-08-07) - Merge competition draft participation foundation.

This merged the durable, Discord-independent guild-scoped entrant and selected
contributing-account foundation. It supports draft-only self join and leave,
plus creator-or-manager add and remove operations; Discord entrants select only
their linked accounts and watchlist accounts remain standalone entrants.

`f20f472` (2026-08-07) - Merge Discord competition draft creation.

This merged the manager-authorized guild-only `/competition create` guided
flow. It collects a name, one of the four approved competition types, a
canonical skill or bounded boss selection, and the required duration or target
value through five-minute guild- and initiator-bound interactions. It uses the
configured guild timezone, keeps results private, and wires the merged
competition creation service into development command registration and runtime
composition.

`6dd9f50` (2026-08-07) - Merge competition draft foundation.

This merged the Stage 8 Discord-independent competition creation foundation:
the four approved individual definitions, durable draft state, per-guild
normalized-name uniqueness, competition-manager authorization, reviewed
PostgreSQL migration and repository, and focused unit and integration coverage.
It deliberately does not expose a Discord command or add entrants, snapshots,
scheduling, claims, standings, roles, or lifecycle transitions.

`88f0ec3` (2026-08-07) - Merge daily recap readability improvements.

This merged the recap caption and readable-layout cleanup. Public and preview
recaps no longer expose technical baseline terminology; player gains are
rendered in a more readable line-based layout without changing collection,
durable delivery, or baseline replacement.

`18c0844` (2026-08-07) - Merge recap embed presentation.

This merged the gold Discord-embed presentation for automatic and manual daily
recaps, private recap previews, skill and boss lookups, both permanent
leaderboards, and public registration confirmations. Recap previews and
delivered recaps share one compact rendering path; XP-only gains below 10,000
are hidden while positive level gains and boss KC remain visible, and every
successful collection still advances its baseline. The merge also retains
compact recap run and retry identity for duplicate-prone delivery.

`a35d071` (2026-08-07) - Merge Discord member-presence events.

This merged configured-guild Discord member join and leave event handling with
per-member transition serialization, the required Guild Members gateway intent,
and Developer Portal prerequisites for both private-beta and development bots.

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

`codex/manual-timed-competition-finalization` adds the missing authorized
manual-completion path for active timed competitions. It uses a bounded,
guild- and initiator-bound `/competition finish` selection and explicit
confirmation, then shares the existing guild-locked finalization, fresh
Hiscores, durable retry, result-delivery, and recovery path. Successful and
pending manual finalization outcomes create optional administrative audit
records without undoing the durable state change if local logging fails.

## Next recommended branch-sized task

After the current manual timed-competition-finalization branch merges, take
the smallest Stage 9 slice: execute and record the real-server competition
acceptance checklist, including a restart during an active competition and an
automatic result delivery or recovery check. The existing daily-recap and
restart acceptance remains recorded for the configured private beta. Do not
claim broader production backup or restore guarantees, which remain explicitly
deferred for this private beta.
