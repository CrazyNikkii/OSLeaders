# OSLeaders Architecture

Version: 0.2  
Status: Approved  
Product specification: `specs/00-product-spec.md` version 0.3

## 1. Purpose and authority

This document defines the initial software architecture for OSLeaders. It
translates the approved product behaviour into module boundaries, data rules,
integration boundaries, runtime behaviour, and a testing strategy.

The product specification remains authoritative for user-visible behaviour.
If this document conflicts with `specs/00-product-spec.md`, the product
specification takes precedence and the conflict must be resolved explicitly.

This architecture is intended to guide implementation without prematurely
fixing details that should be verified during setup or deployment. In
particular:

- Production uses a supported Node.js LTS release. The exact release is
  verified and recorded during project setup and again during deployment.
- A lightweight headless Linux distribution is used in production. Debian
  Stable is preferred, but the exact distribution and version remain
  provisional until tested on the production laptop.
- PostgreSQL runs locally and directly on both the Windows development
  machine and the production Linux system. Containers are not required.

## 2. Architectural goals

The architecture prioritizes:

1. Correct product behaviour and strict isolation between Discord guilds.
2. Reliable recovery after process, network, or machine interruption.
3. Deliberately small CPU and memory usage on a 4 GB laptop.
4. Testable product rules that do not depend on Discord or live Jagex access.
5. A straightforward Windows development workflow.
6. Clear code that can be maintained without a large framework.
7. No required recurring service costs.

OSLeaders is intended for small private communities. The architecture does not
optimize for public, internet-scale distribution.

## 3. Constraints and non-goals

The initial production deployment contains exactly these long-running
application components:

- One OSLeaders Node.js process.
- One local PostgreSQL instance.
- The operating system's normal service and logging facilities.

The architecture does not require:

- Docker in production.
- Redis.
- A message broker or queue service.
- Microservices.
- A separate scheduler or worker process.
- Paid cloud services.
- A web dashboard.
- RuneLite or a RuneLite plugin.

Additional processes or services may be proposed later only when measurement
shows a genuine need and the product and operating constraints still permit
them.

## 4. Technology choices

### 4.1 Application platform

- **TypeScript** provides explicit types for domain concepts, identifiers,
  state transitions, and integration results.
- **Node.js LTS** provides the single-process asynchronous runtime. Production
  must use a Node.js release that is in Active LTS or Maintenance LTS and is
  supported by the selected application dependencies.
- **discord.js** provides Discord Gateway, command, interaction, component,
  role, and message APIs.
- **Vitest** provides unit, component, and integration test execution.

Exact dependency versions are selected and locked during project setup. Major
runtime or dependency upgrades require their automated tests to pass before
deployment.

### 4.2 Database access

PostgreSQL is the sole persistent datastore.

The initial database access stack is:

- **Drizzle ORM** for typed schema declarations and routine queries.
- **Drizzle Kit** for version-controlled SQL migration generation and
  execution.
- **node-postgres** as the PostgreSQL driver beneath Drizzle.
- Explicit SQL where PostgreSQL constraints, locking, or a complex query are
  clearer than an ORM expression.

Drizzle is a compile-time and query-building aid, not a separate service. The
database schema remains an important enforcement boundary. Generated
migrations must be reviewed, committed, and tested; production schema changes
must not use an unreviewed schema-push workflow.

### 4.3 Time handling

- Instants are stored in UTC.
- Durations are stored explicitly rather than inferred from display times.
- IANA timezone names such as `Europe/Helsinki` are stored for recurring local
  schedules and user-facing interpretation.
- Discord-native timestamps are used where practical for display.
- A date/time library may be selected during setup if the supported Node.js
  runtime APIs do not provide sufficiently clear timezone behaviour.

## 5. System context

OSLeaders communicates with four external boundaries:

1. **Discord** supplies commands, interactions, members, permissions, roles,
   channels, and outgoing messages.
2. **Jagex Old School Hiscores** supplies current account statistics.
3. **PostgreSQL** stores all durable state.
4. **The operating system** supplies process supervision, local logs, clock,
   networking, and scheduled work.

All external boundaries are accessed through application-owned adapters. Core
product rules must not directly call discord.js, node-postgres, the operating
system, or the network.

## 6. Architectural style

OSLeaders is a feature-based modular monolith: one deployable application with
strong internal module boundaries.

A normal request flows through these layers:

1. A Discord adapter parses an interaction.
2. An application service authorizes and coordinates the use case.
3. Domain code applies product rules and state transitions.
4. Repository and integration interfaces perform database or network work.
5. A Discord presenter converts the result into messages, embeds, or
   components.

Discord handlers remain thin. Slash commands call application services and
presenters without duplicating business rules. Any future prefix commands must
reuse those same services and presenters wherever they offer equivalent
behaviour.

No dependency-injection framework is required. The process entry point creates
the concrete adapters and passes them to services through small constructor or
factory parameters.

## 7. Module boundaries

The initial feature modules are:

### 7.1 Accounts

Owns registration, validation coordination, linked and watchlist association,
default accounts, renaming, mode changes, conversion, deletion, member
presence, quotas, and account history events.

### 7.2 Lookups

Owns tracked and one-time player-stat lookup use cases, target resolution, and
partial-success result assembly. One-time accounts are transient values and
are never passed to a persistence operation.

### 7.3 Leaderboards

Owns current skill and boss rankings, omission rules, partial results,
pagination, and display-ready ranking models.

### 7.4 Competitions

Owns competition creation, permissions, entrants, contributing accounts,
snapshots, scheduling, state transitions, standings, target claims, results,
roles, and retained history.

### 7.5 Recaps

Owns recap configuration, rolling baselines, fresh collection, change
calculation, preview, manual send, automatic send, failure reporting, and the
compact active-competition section.

### 7.6 Guild configuration

Owns per-guild timezone, mode emojis, bot-manager and
competition-manager role IDs, recap configuration, and administrative log
configuration.

### 7.7 Audit

Owns sanitized administrative events, error-reference IDs, standard and
verbose log policy, and the interface to local technical logging.

### 7.8 Shared kernel and infrastructure

Small shared types may cover guild-scoped identifiers, clocks, transactions,
pagination, normalized names, and structured errors. Infrastructure contains
Discord, PostgreSQL, Hiscores, scheduler, configuration, and logging adapters.

Feature modules may use another feature's declared application interface or
read model. They must not reach into another feature's private implementation
or issue ad hoc queries against another feature's tables.

## 8. Guild isolation

Discord guild ID is the tenant boundary. Every guild-owned record includes a
`guild_id`, including configuration, accounts, associations, baselines,
competitions, entrants, roles, jobs, and delivery records.

Isolation is enforced at several levels:

- Application commands establish the guild context before calling a service.
- Guild-scoped repository methods require a guild ID; there is no optional
  global form of those methods.
- Database foreign keys include or otherwise verify guild ownership where
  practical.
- Uniqueness constraints include `guild_id`.
- Updates and deletes include the guild ID in their predicates, even when the
  internal row ID is globally unique.
- Responses are built only from records loaded under the current guild.
- Automated tests seed two guilds with deliberately overlapping Discord IDs,
  usernames, and competition names and verify isolation.

Row-level security is not initially required. It would not replace correct
application scoping and would add operational complexity to a single-role,
single-process deployment. It may be reconsidered if the database access model
changes.

## 9. Identity, names, and quotas

### 9.1 Stable identity

Each tracked account receives a stable internal account ID. Renaming or
association conversion changes account attributes without replacing that ID.
Competition snapshots refer to the stable ID while also retaining the
historical display name and mode required by the product specification.

Discord snowflakes are stored without numeric conversion that could lose
precision.

### 9.2 Username normalization

One centralized OSRS username value object performs validation, lookup
normalization, uniqueness normalization, and display preservation. The exact
accepted character and whitespace rules must be verified against live Jagex
behaviour before implementation.

At minimum, comparisons are case-insensitive, surrounding whitespace is
removed, and equivalent RuneScape spacing forms are normalized consistently.
The originally approved or most recently validated display form is retained.

The database enforces uniqueness of normalized username within a guild, not
globally. A mode or association change cannot bypass this constraint.

### 9.3 Approved quota attribution

The maximum is ten quota-bearing accounts per Discord member per guild:

- A linked account is charged to its linked Discord member.
- A watchlist account is charged to the Discord member who added it.
- An administrator managing another member's account does not consume the
  administrator's quota merely because they performed the action.
- Reassignment or conversion is rejected if it would make the destination
  member exceed the limit.

Quota checks and the corresponding write occur in one transaction. Database
locking or an equivalent serialization mechanism prevents simultaneous
registrations from exceeding the limit.

## 10. Permissions and authorization

Authorization is checked inside application services, not only in Discord
handlers. This ensures slash commands, component callbacks, scheduled actions,
and future adapters cannot accidentally apply different rules.

The approved permission model is:

- Discord's Administrator permission represents a server administrator.
- One optional configurable bot-manager role handles account administration,
  guild configuration, recap administration, and related operational tasks.
- One optional configurable competition-manager role handles competition
  creation and management.
- Self-service actions remain limited as specified by the product rules.

The permissions required for each individual use case must be listed beside
its command during implementation. A configured role grants only its stated
OSLeaders capabilities; it does not imply Discord Administrator permission.

The bot also checks its own Discord permissions before attempting role or
message operations. A Discord permission failure degrades the optional action
where the specification permits, gives the user a clear explanation, and
creates a sanitized audit event.

## 11. Account state rules

- The first linked account for a member becomes the default in the same
  transaction as registration.
- Exactly one remaining linked account is selected when a default is removed;
  selection uses the oldest registration with a stable ID as a tie-breaker.
- Watchlist accounts can never be defaults.
- A member's departure changes presence state without deleting or unlinking
  accounts.
- Rejoining with the same Discord user ID restores presence.
- Conversion between linked and watchlist association is blocked in either
  direction while the account contributes to an active competition.
- Deletion, mode changes, and normal renaming obey the active-competition
  restrictions in the product specification.
- An administrator-approved active-competition rename preserves the stable
  account ID and creates an audit event.

Deletion removes active registration and recap baseline data. Finished and
cancelled competition records retain denormalized historical names, modes,
values, and results rather than relying on the active registration to remain.

## 12. Database model

The initial logical schema contains the following groups. Exact table and
column names are implementation details, but their ownership and constraints
are architectural requirements.

### 12.1 Guild and account data

- Guild configuration and configured role/channel IDs.
- Tracked accounts with stable ID, guild ID, display and normalized username,
  selected mode, association type, registration metadata, and active state.
- Linked-account association to a Discord user.
- Watchlist attribution to the member who added it.
- Default-account selection.
- Member presence state.
- Account history/audit facts needed to preserve registration and conversion
  history.
- One current recap baseline per active tracked account.

### 12.2 Competition data

- Competition identity, normalized unique name, type, metric, target,
  timezone, intended schedule, intended duration, actual timestamps, state,
  creator, and manager metadata.
- Entrants, distinguishing Discord entrants from standalone watchlist
  entrants.
- Selected contributing accounts.
- Per-account starting, latest-known, and final values with observation times.
- Retained result summaries and winner information.
- Optional temporary Discord role state.

Values that can exceed JavaScript's safe integer range, including skill XP
aggregates and Discord IDs, must use safe representations such as PostgreSQL
`bigint` with application-level `bigint` or strings. They must not be silently
converted to unsafe JavaScript numbers.

### 12.3 Scheduling and delivery data

- Durable scheduled-operation records or equivalent due-time fields on their
  owning aggregates.
- Execution attempt and retry metadata.
- Durable outgoing-notification records for important automated posts.
- Recap-run records sufficient to resume or safely retry an interrupted send.

### 12.4 Constraints

Important invariants are enforced in both domain logic and PostgreSQL when
possible. These include:

- Unique normalized account username per guild.
- Unique normalized competition name per guild.
- Valid account association shape.
- No default for a watchlist account.
- At most one default linked account per Discord member per guild.
- Valid competition type and lifecycle state.
- Unique membership and contributing-account relationships.
- Guild-consistent foreign-key relationships.

Database transactions protect multi-row operations such as registration,
default replacement, conversion, starting and finishing competitions, target
claims, and baseline advancement.

## 13. Competition lifecycle and concurrency

The persisted lifecycle is:

```text
DRAFT -> START_PENDING -> ACTIVE -> FINISH_PENDING -> FINISHED
  |            |            |              |
  +------------+------------+--------------+----> CANCELLED
```

`DRAFT` transitions through the due-time scheduler when its configured intended
start is reached. `ACTIVE` may transition directly to `FINISHED` when all
final values succeed immediately. Pending states make delayed external work
visible and recoverable.

Each lifecycle command:

1. Locks or atomically condition-checks the competition row.
2. Verifies the current state and caller authorization.
3. Records the state transition and durable follow-up work.
4. Commits before optional Discord side effects are attempted.

This prevents two managers, a scheduler, and a claim handler from producing
conflicting transitions.

Membership and contributing accounts lock when starting begins. A delayed
start uses the actual successful snapshot time, and the finish deadline is
derived from that time plus the stored intended duration.

For progress fetches, each successful per-account value may replace that
account's latest-known value and observation time. A failed account retains its
previous latest-known value and is marked stale in the result.

## 14. Target-race claims

Target races are claim-driven and never require constant polling.

When a target race has an optional deadline and no successful claim has won
before it, the normal durable finish workflow fetches final values and selects
the entrant or entrants with the highest combined gain. Exact highest gains are
retained as shared winners.

The bot records the claim receipt instant in UTC before performing Hiscore
requests. For competitions with a deadline:

- A claim received after the stored deadline cannot win.
- A claim received on or before the deadline may continue verification even
  if the external fetch completes after the deadline.

The precise equality boundary must be implemented consistently; the stored
receipt instant is authoritative.

A claim bypasses normal cache, fetches every contributing account, and
calculates combined gain from persisted starting values. The winning decision
is committed under a competition lock. If concurrent valid claims occur, the
earliest recorded receipt time wins; stable claim ID provides a deterministic
tie-breaker if timestamps are equal.

Claims from absent members and watchlist entrants follow the authority rules
in the product specification.

## 15. Hiscores integration

One centralized Hiscores client owns endpoints, request construction,
timeouts, retries, concurrency, parsing, validation, and cache policy.

### 15.1 Verification before implementation

Before account and snapshot implementation is considered complete, a focused
integration investigation must verify:

- The available Old School endpoints for every displayed mode.
- Which modes Jagex data can independently verify.
- Username encoding and normalization behaviour.
- The complete skill and activity row layout.
- Unranked, unavailable, malformed, and incomplete result behaviour.
- Reasonable timeout, retry, and concurrency settings.

Representative sanitized responses become test fixtures. The bot must not
claim that a mode is independently verified when the selected Jagex strategy
cannot prove it.

### 15.2 Cache and request policy

- Successful ordinary lookups and standings use a bounded in-memory cache
  with a one-minute time to live.
- Cache keys include normalized username and fetching mode/endpoint.
- Failures are not cached as successful data. A very short failure backoff may
  be used to suppress a request storm.
- Snapshot-changing operations bypass the cache.
- Temporary failures receive one retry after a short bounded delay.
- Requests use an explicit timeout and a small concurrency limiter. Initial
  values are selected conservatively and measured rather than treated as
  permanent constants.
- The cache has a maximum entry count and does not survive restart.

### 15.3 Result model

The client returns an explicit result rather than throwing unclassified
network errors into feature code. Results distinguish success, not found,
mode incompatibility, timeout, temporary upstream failure, malformed data, and
incomplete data.

Leaderboard, lookup, recap, and competition services decide how their product
rules handle each result. One account failure does not erase successful
results for other accounts.

## 16. Recap snapshots

Each tracked account has one complete rolling baseline containing all expected
skill XP, normal skill levels, boss KC values, and one capture instant.

Baseline replacement is atomic per account. An incomplete or failed response
does not partially update it. Historical daily snapshots are not retained.

### 16.1 Automatic recap

A durable recap run records its guild, scheduled time, actual collection
period, status, account outcomes, and outgoing content reference. Collection
uses fresh Hiscore results. Successful complete account results produce both
changes and candidate replacement baselines; failures preserve their prior
baselines.

Only one baseline-advancing recap operation may run for a guild at a time.
Preview never acquires authority to advance baselines. Manual send requires
confirmation and is serialized with automatic sends.

The implementation order must avoid silently advancing all baselines without
a durable record of the post that should be delivered. The exact transaction
layout will be defined with the schema, but interrupted runs must be
recoverable.

### 16.2 Delivery guarantee

PostgreSQL and Discord cannot participate in one atomic transaction. OSLeaders
therefore uses durable at-least-once delivery for important automated
notifications:

- A post is recorded durably before delivery is attempted.
- Success records the Discord message reference when available.
- Uncertain or failed delivery is retried conservatively.
- A crash after Discord accepts a post but before PostgreSQL records success
  may produce a rare duplicate.
- The system prefers that rare duplicate over silently losing a recap or
  competition result.
- Retried or duplicate-prone delivery should be clearly identifiable where
  practical.

This policy applies to daily recaps and important automated competition
notifications. It does not justify repeated pings: retry logic must suppress
role mentions when the original delivery may already have succeeded whenever
Discord state provides enough evidence.

## 17. Scheduler and restart recovery

The scheduler runs inside the single Node.js process. PostgreSQL, not an
in-memory timer, is the source of truth for due work.

The scheduler:

- Polls at a restrained interval for due work.
- Uses database locking or atomic claims so work is not run concurrently.
- Persists attempt status, next retry time, and a sanitized failure summary.
- Applies bounded retry intervals appropriate to the operation.
- Checks for overdue work immediately after application startup.
- Uses the same application services as manual commands.
- Never holds a database transaction open while waiting on a slow external
  network request unless a narrowly reviewed operation requires it.

Long Hiscore work is coordinated through short claim, fetch, and finalize
phases with state revalidation. This keeps locks short while preventing stale
work from overwriting a newer state.

Recurring daily recaps follow the guild's local wall-clock time and timezone.
One-time competition boundaries are persisted as UTC instants after their
local input is resolved. Daylight-saving gaps or ambiguous local times must be
reported during configuration rather than silently guessed.

## 18. Discord interface

### 18.1 Slash commands

Slash commands are the complete supported interface. Interaction adapters own
Discord-specific input fields, select menus, autocomplete, buttons, response
deferral, and ephemeral/public delivery decisions.

Long-running interactions are acknowledged before Discord's response window
expires. Confirmation tokens bind the requesting user, guild, intended action,
and a short expiry so another user cannot reuse a destructive confirmation.

### 18.2 Post-v1 prefix commands (deferred)

Prefix commands are outside v1 and must not require the Discord Message
Content intent in the v1 runtime. If introduced after v1, their parser must:

- Treat command and alias text case-insensitively.
- Use centralized skill and boss alias resolution.
- Resolve the longest valid boss prefix.
- Treat remaining text as an unquoted multi-word RSN.
- Suggest rather than guess when resolution is ambiguous.

Future prefix and slash adapters must produce the same application request
models and use the same feature services and result presenters.

### 18.3 Output limits

Presenters enforce Discord limits centrally. Valid data is split across
numbered embeds or messages and never silently truncated. Account mode always
has a text label; emojis are decorative and optional.

Partial-success output contains successful results plus a distinct failed or
stale section.

## 19. Competition roles and Discord side effects

Competition role creation and assignment are helpful side effects, not
preconditions for a valid competition. Role state is persisted sufficiently
to retry cleanup and recover after restart.

Role operations are idempotent where Discord permits:

- Creating avoids creating a second role when a stored valid role exists.
- Assignment tolerates a member already having the role.
- Removal tolerates a missing member or role.
- Cleanup attempts removal before deletion and records unresolved failures.

Watchlist accounts and absent members are never assigned the role. Important
event notifications follow the product specification's ping policy.

## 20. Errors, audit, and logging

### 20.1 Error handling

Expected errors use typed categories such as validation, authorization,
conflict, unavailable dependency, and internal failure. An unexpected failure
is caught at each entry-point boundary so it cannot crash the Discord process.

User-facing errors and administrative summaries receive a short random or
time-sortable error-reference ID. The reference links those messages to local
structured logs without exposing a stack trace.

### 20.2 Administrative audit

Audit events are structured application events, not arbitrary formatted log
strings. The Discord audit adapter applies Standard or Verbose policy and
sanitizes data before delivery.

Verbose command arguments are resolved and sanitized. Secrets, raw
environment variables, full stack traces, and sensitive ephemeral content are
never sent to Discord.

Failure to post an administrative log must not recursively create unlimited
audit failures or undo the underlying valid product operation.

### 20.3 Local logs

The application writes structured logs to standard output. On production,
systemd captures them and journald supplies bounded rotation and retention.
Development may use a human-readable formatter.

Logs include timestamps, severity, error reference, guild ID where relevant,
operation, duration, and sanitized context. A central redaction policy covers
Discord tokens, database URLs, credentials, and configured secret fields.

## 21. Configuration and secrets

Runtime configuration is loaded and validated once at process startup.
Required secrets and environment-specific values include the Discord token,
Discord application identity, database connection information, and log level.

- Secrets are supplied through local environment configuration or protected
  operating-system environment files.
- Real secret files are ignored by Git.
- A committed example file contains names and documentation only.
- Development and production use different Discord applications, tokens,
  databases, and environment files.
- Startup fails clearly before connecting to Discord when required
  configuration is absent or invalid.

Guild-configurable product settings live in PostgreSQL rather than environment
variables.

## 22. Performance and resource budget

The application is designed for the production laptop rather than an assumed
cloud environment.

Initial operating defaults are deliberately small:

- One Node.js process with no in-process worker pool.
- A PostgreSQL connection pool initially capped at approximately four
  connections, then adjusted only from measurement.
- A small bounded Hiscore request concurrency limit.
- Bounded caches with short lifetimes.
- Database pagination and Discord-aware response chunking.
- No retention of routine Hiscore responses or progress history.
- Restrained scheduler polling and retries.

Startup and deployment checks should record idle memory, memory during a full
guild recap, database size, recap duration, and Hiscore error rates. Limits are
tuned using those measurements. PostgreSQL is configured conservatively for a
shared 4 GB system rather than using settings intended for a dedicated large
database server.

## 23. Development environment

Initial development uses a native PostgreSQL installation on Windows. This
choice may be reconsidered if it creates a demonstrated practical problem.

The development workflow will provide commands for:

- Installing locked Node.js dependencies.
- Validating environment configuration.
- Creating or migrating the separate development database.
- Running formatting, linting, type-checking, unit tests, and integration
  tests.
- Registering commands against the separate development Discord application.
- Starting the bot in development mode.

Automated tests use a separate test database or isolated test schemas; they do
not wipe or reuse development or production data. Any command capable of
resetting test data verifies the target environment explicitly.

## 24. Production deployment

The preferred production candidate is a minimal headless Debian Stable
installation, subject to an installation and soak test on the actual laptop.
The application must not depend unnecessarily on Debian-specific behaviour.

The deployment design uses:

- A dedicated unprivileged OSLeaders system user.
- A systemd service with automatic restart and a restrained restart policy.
- Node.js and PostgreSQL installed directly on the host.
- PostgreSQL bound locally unless deployment testing identifies a justified
  need for remote access.
- Minimal filesystem permissions for secrets.
- Graceful shutdown that stops accepting work, closes Discord, and closes the
  database pool.
- Database migrations as an explicit deployment step, not an uncontrolled side
  effect of every application startup.

The exact Linux distribution, release, Node.js LTS release, PostgreSQL release,
and installation method are recorded in the deployment specification after
hardware testing.

## 25. Testing strategy

Testing is layered so most rules run quickly without Discord, PostgreSQL, or
live Jagex access.

### 25.1 Unit tests

Pure tests cover:

- Name and alias normalization.
- Target parsing and longest-boss matching.
- Quotas, permissions, defaults, conversion, and active-competition guards.
- Leaderboard sorting, zero-KC omission, ties, and partial results.
- Competition gains, combined scoring, ranks, deadlines, and transitions.
- Recap positive-change calculation and comparison-period wording.
- Discord output pagination and limit handling.

### 25.2 Database integration tests

Tests against real PostgreSQL cover:

- Migrations from an empty database.
- Guild isolation and composite uniqueness.
- Quota and default-account races.
- Transactions, locks, and concurrent competition claims.
- Atomic baseline replacement.
- Restart-visible schedules and delivery records.
- Preservation of finished competition history after account deletion.

Database-specific behaviour must not be tested only with an in-memory
substitute.

### 25.3 Adapter and contract tests

- Hiscore parsing uses stored sanitized fixtures for success and failure
  shapes.
- Hiscore client tests use a controlled HTTP server for timeout, retry, cache,
  and concurrency behaviour.
- Discord adapters use focused tests for authorization inputs, response
  visibility, component binding, and message splitting.
- A small manual checklist validates real development-bot interactions.

Live Jagex tests are kept separate from deterministic automated tests because
external availability and account values change.

### 25.4 Recovery tests

Tests simulate interruption during pending start, pending finish, recap send,
notification delivery, and role cleanup. Restarting the application must
resume durable work without corrupting state. Rare duplicate delivery is an
accepted outcome only at the documented external-transaction boundary.

## 26. Acceptance-criteria traceability

The product acceptance criteria are covered by these architectural areas:

| Product criteria | Primary architecture coverage |
| --- | --- |
| 1-6: accounts, modes, defaults, isolation | Accounts module; guild isolation; identity, quotas, and constraints |
| 7-12: lookups and leaderboards | Lookups and Leaderboards modules; Hiscores client; partial results |
| 13-18: competitions and roles | Competition lifecycle, concurrency, target claims, scheduler, role adapter |
| 19-22: daily recaps and failures | Atomic recap snapshots, durable recap runs, Hiscore result model |
| 23-25: audit, history, long output | Audit and logging, historical records, centralized presenters |
| 26-27: cache, cooldowns, environment separation | Hiscore policy, command policy, configuration and secrets |
| 28: automated tests | Unit, PostgreSQL integration, contract, and recovery tests |
| 29: production deployment | Headless service deployment and resource budget |

Each implementation stage should identify the relevant product acceptance
criteria, and the test suite should provide clear coverage for them. Passing
tests do not replace a final end-to-end acceptance review.

## 27. Implementation sequence

After this architecture is approved, implementation should proceed in small,
reviewable stages:

1. Project skeleton, dependency locking, configuration validation, code
   quality tools, and test harness.
2. Database connection, migration mechanism, guild isolation primitives, and
   integration-test database safety.
3. Hiscores investigation, result model, parser fixtures, and centralized
   client.
4. Guild configuration, permissions, and audit foundations.
5. Account registration and management as the first vertical feature slice.
6. Lookups and permanent leaderboards.
7. Daily recap configuration, collection, preview, durable send, and automatic
   scheduling. Active-competition summaries follow once competition read models
   exist.
8. Competition lifecycle, snapshots, claims, scheduling, roles, and history.
9. Full acceptance, failure-recovery, resource, and deployment testing.
10. Deployment refinement based on the actual laptop.

Each stage should include its migrations, tests, documentation, and a review
of relevant acceptance criteria. OpenSpec, custom skills, or additional agent
tooling are not prerequisites for this workflow.

## 28. Deferred decisions and required investigations

The following are deliberately deferred rather than accidentally omitted:

- Exact supported Node.js LTS and package versions at setup and deployment.
- Exact production Linux distribution and version after laptop testing.
- Exact PostgreSQL release after development and production compatibility
  checks.
- Final Hiscores endpoint mapping and mode-verification matrix after live
  investigation.
- Measured connection-pool, request-concurrency, timeout, retry, and cache-size
  values.
- Exact command names and Discord interaction layouts within the approved
  product behaviour.
- Exact tables and columns, to be proposed with the initial data-model
  migration.

Changing a product rule requires updating the product specification first.
Changing a significant architectural decision requires reviewing and updating
this document. Ordinary implementation details may be selected during the
relevant feature work as long as they remain consistent with both documents.
