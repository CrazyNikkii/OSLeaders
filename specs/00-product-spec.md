# OSLeaders Product Specification

Version: 0.3
Status: Approved for architecture design

## 1. Product summary

OSLeaders is a Discord bot for private Old School RuneScape communities.

The bot allows Discord servers to:

- Track registered OSRS accounts.
- View skill levels, experience and boss kill counts.
- Compare tracked accounts through permanent leaderboards.
- Run skill-XP and boss-KC competitions.
- Publish an automatic daily activity recap.
- Track both Discord-linked accounts and external watchlist accounts.

The bot is intended for small private communities rather than large-scale public distribution.

## 2. Main product areas

The first complete version contains five primary feature areas:

1. Account registration and management.
2. Player stat lookups.
3. Permanent server leaderboards.
4. Competitions.
5. Automatic daily recaps.

The first version also includes server configuration, permissions, administrative logging and error handling.

## 3. Server separation

Each Discord server has its own independent data.

The following must never be shared automatically between servers:

- Registered accounts.
- Linked Discord users.
- Watchlist accounts.
- Default accounts.
- Leaderboards.
- Competitions.
- Competition roles.
- Daily recap configuration.
- Administrative log configuration.

The same OSRS account may be registered independently in different Discord servers.

Within one Discord server, a normalized OSRS username may only be registered once, regardless of capitalization, selected game mode or account association type.

Renaming an account is rejected if the new normalized username is already tracked in that server.

## 4. OSRS account types

OSLeaders supports two forms of tracked account.

### 4.1 Linked account

A linked account is associated with a Discord user in the current server.

A linked account may:

- Be selected as the user’s default account.
- Be targeted through a Discord mention.
- Be grouped under the Discord user in daily recaps.
- Be used as part of the user’s combined competition score.
- Be edited or removed by the linked user.
- Be managed by authorized account administrators.

Registration does not prove ownership of the RuneScape account. A linked account only represents a server-managed association.

### 4.2 Watchlist account

A watchlist account is tracked by the server without being linked to a Discord member.

A watchlist account may:

- Appear in permanent leaderboards.
- Appear in daily recaps.
- Be queried by its RuneScape name.
- Participate in competitions as a standalone entrant.

A watchlist account cannot:

- Be somebody’s default account.
- Be targeted through a Discord mention.
- Receive a Discord competition role.
- Submit its own target-race claim.

The user who added the watchlist account and authorized account administrators may edit or remove it.

## 5. Account limits and uniqueness

A Discord user may add or manage a maximum of 10 tracked accounts per server.

This limit includes:

- Linked accounts associated with that user.
- Watchlist accounts added by that user.

The limit does not include one-time lookup accounts because those are not stored.

A server may contain more than 10 total tracked accounts when several users add accounts.

## 6. Account game modes

The product supports these displayed account modes:

- Main
- Ironman
- Hardcore Ironman
- Ultimate Ironman
- Group Ironman
- Hardcore Group Ironman

The account mode belongs to the OSRS account, not to the Discord user.

OSLeaders retrieves player statistics directly from Jagex's Old School Hiscores service. The service returns rank, level and experience or activity score data. OSLeaders does not require RuneLite or RuneLite plugins.

The exact Jagex hiscore endpoint or fetch strategy for every supported mode must be verified before implementation is considered complete.

Group Ironman and Hardcore Group Ironman must remain distinct displayed modes. If Jagex's individual hiscore data cannot independently verify one of these modes, OSLeaders validates that the account can be fetched through the appropriate available Old School Hiscores strategy and stores the selected mode as server-managed account information. The bot must not describe an account mode as independently verified when the Jagex data cannot verify it.

## 7. Account registration

Account registration is primarily a guided slash-command interaction.

For account administration, an authorized account administrator is either:

- A member with Discord Administrator permission.
- A member with the configured bot-manager role.

The bot-manager role may perform approved account-administration actions,
including registering an account for another member, editing accounts,
reassignment, conversion approval and removal. The competition-manager role
remains limited to competition management and does not grant general
account-administration authority.

A normal user may register a linked account only for themselves. An authorized account administrator may register or reassign a linked account for another Discord member. Any permitted server member may add a watchlist account, subject to the normal account limit.

The registration flow must:

1. Ask for the OSRS username.
2. Ask whether the account is linked or watchlisted.
3. If linked, ask which Discord member it should be linked to when necessary.
4. Present the supported game modes through a Discord select menu.
5. Display a text label for every game mode.
6. Allow configurable custom game-mode emojis.
7. Validate the username through Jagex's Old School Hiscores service and validate the selected mode where the available Jagex data supports independent mode verification.
8. Reject the registration when the username cannot be fetched, or when the selected mode is verifiably incompatible with the returned data.
9. Save the account only after successful validation.
10. Immediately create the first daily-recap baseline.
11. Announce successful registration publicly.
12. Log the registration in the configured administrative channel.

Users do not manually type the game mode. This prevents spelling mistakes such as `ironnan`.

The first linked account registered for a Discord user in a server automatically becomes their default account.

## 8. Default accounts

Every Discord user with at least one linked account has exactly one default account per server.

Commands without an explicit account target use the caller’s default account.

When the default account is removed:

- The oldest remaining linked account becomes the new default.
- The bot clearly tells the user which account became the new default.

Users may change their default account through account-management commands.

Watchlist accounts cannot become default accounts.

## 9. Account editing and removal

Linked accounts may be:

- Renamed after an OSRS name change.
- Changed to another game mode after successful validation.
- Removed by the linked Discord user.
- Managed by authorized account administrators.

Watchlist accounts may be:

- Renamed.
- Changed to another game mode after successful validation.
- Removed by the user who added them.
- Managed by authorized account administrators.

Removing an account requires explicit confirmation through an interaction button.

When an account is deleted:

- Its active registration is removed.
- Its daily-recap baseline is removed.
- Completed competition history retains the account name, mode, starting value, final value and gain.

## 10. Accounts in active competitions

When an account contributes to an active competition:

- It cannot be deleted.
- Its game mode cannot be changed.
- Normal self-service renaming is blocked.

An authorized account administrator may approve a genuine RSN change during an active competition when:

- The account is successfully validated.
- The administrator confirms the change.
- The account keeps the same stable internal identity.
- The action is recorded in the administrative log.

## 11. Linked members leaving the server

When a linked Discord member leaves the server:

- Their tracked accounts are not deleted.
- Their accounts remain linked to the same Discord user ID.
- The bot marks the member as no longer present in the server.
- The accounts remain available for leaderboards, recaps and competition history.

A competition manager may add such an account to a new competition.

The absent Discord user cannot:

- Join the competition themselves.
- Receive the competition role.
- Submit their own target-race claim.

An authorized competition manager may submit a claim on behalf of an absent entrant when necessary.

If the Discord user later rejoins using the same Discord account, the existing link becomes active again automatically.

## 12. Converting account association

A watchlist account may be converted into a linked account with authorized account-administrator approval.

This conversion must preserve:

- Daily-recap baseline.
- Competition history.
- Internal account identity.
- Original registration history.

A linked account may be converted into a watchlist account by:

- The linked Discord user.
- An authorized account administrator.

The conversion is blocked while the account contributes to an active competition.

OSLeaders does not claim that linked accounts are ownership-verified. Authorized account administrators resolve false or incorrect links.

## 13. Command interfaces

For v1, OSLeaders supports Discord slash commands as its complete official
interface. Prefix commands are explicitly deferred until after v1.

### 13.1 Slash commands

Slash commands are the complete official interface.

They support:

- Account registration and management.
- One-time lookups.
- Player statistics.
- Leaderboards.
- Competition creation and management.
- Daily recap configuration.
- Server configuration.
- Administrative actions.

Slash commands should use:

- Input fields.
- Select menus.
- Buttons.
- Autocomplete.
- Ephemeral responses where appropriate.

### 13.2 Post-v1 prefix commands

After v1, prefix commands may be introduced as fast convenience shortcuts.

They are intended primarily for:

- Skill lookups.
- Boss-KC lookups.
- Permanent leaderboards.
- Competition standings.
- Other frequently used read-only commands.

Administrative configuration would not need a full prefix-command duplicate.

Any future prefix interface must use the same underlying business behaviour
and produce equivalent results as the slash interface.

## 14. Text input behaviour

Slash-command option matching is case-insensitive where users supply text,
including OSRS usernames. Future prefix-command input must also be
case-insensitive.

The following are post-v1 prefix-command examples:

- `!lvl str`
- `!LVL STR`
- `!Lvl Strength`

OSRS usernames are matched case-insensitively but displayed using their stored form.

Future prefix commands will support common aliases through centralized alias
resolution.

Examples include:

- `str` → Strength
- `wc` → Woodcutting
- `rc` → Runecraft
- `hp` → Hitpoints
- `sire` → Abyssal Sire
- `cg` → Corrupted Gauntlet

Future prefix commands may correct obvious unambiguous spelling mistakes
automatically.

Example:

- `strenght` → Strength

The bot must not silently guess when several valid interpretations are
possible. Future prefix commands should instead show likely suggestions.

## 15. Future prefix-command multi-word usernames and bosses

When prefix commands are introduced after v1, multi-word OSRS usernames will
not require quotation marks.

Example:

`!lvl str enjoyer btw`

means:

- Skill: Strength
- Account: `enjoyer btw`

For future prefix boss commands, the bot resolves the longest valid boss name
or alias from the beginning of the input.

Example:

`!kc abyssal sire enjoyer btw`

means:

- Boss: Abyssal Sire
- Account: `enjoyer btw`

An absent account target means the caller’s default account.

A Discord mention targets all linked accounts belonging to that Discord user.

## 16. Player-stat lookups

OSLeaders supports skill and boss lookups for tracked accounts.

Targeting rules:

- No target → caller’s default linked account.
- Discord mention → all linked accounts belonging to that Discord user.
- Plain RSN → one specific linked or watchlist account.
- Slash-command lookup → may target an unregistered account.

When a Discord member has several linked accounts, the bot displays all of them in one response.

If one account fetch succeeds and another fails:

- Successful accounts are still displayed.
- Failed accounts are reported separately.
- The whole command does not fail unnecessarily.

## 17. One-time unregistered lookups

Users may query an unregistered OSRS account through a separate one-time lookup flow.

The user provides:

- OSRS username.
- Game mode.
- Requested skill or boss.

A one-time lookup account is never saved.

It does not:

- Become linked.
- Become watchlisted.
- Count toward account limits.
- Appear on leaderboards.
- Receive daily recaps.
- Participate in competitions.
- Create a recap baseline.

## 18. Permanent leaderboards

Permanent leaderboards compare current hiscore values for all tracked accounts in the current Discord server.

They include:

- Linked accounts.
- Watchlist accounts.

Every tracked OSRS account appears separately, even when one Discord user has several accounts.

### 18.1 Skill leaderboards

Skill leaderboards:

- Display level and experience.
- Sort primarily by experience.
- Always show the account’s game mode.
- Show the linked Discord owner when useful.
- Mark watchlist entries clearly.

### 18.2 Boss leaderboards

Boss leaderboards:

- Sort by current kill count.
- Omit zero-KC accounts unless all tracked accounts have zero.
- Always show the account’s game mode.
- Show the linked Discord owner when useful.
- Mark watchlist entries clearly.

Slash commands show the top 10 by default and allow users to request more or all entries.

If some tracked accounts cannot be fetched, the leaderboard still displays all successfully fetched accounts and reports the failed accounts separately. A failed account must not cause the entire leaderboard request to fail.

## 19. Competition types

The first version supports exactly four individual competition types.

### 19.1 Most skill XP gained

Winner: entrant with the most XP gained in one selected skill during the competition period.

### 19.2 Skill XP target race

Winner: first entrant to submit a successful verified claim after gaining the required amount of XP in one selected skill.

### 19.3 Most boss KC gained

Winner: entrant with the most KC gained for one selected boss during the competition period.

### 19.4 Boss KC target race

Winner: first entrant to submit a successful verified claim after gaining the required amount of KC for one selected boss.

The first version does not include:

- Team competitions.
- Combined-skill competitions.
- Combined-boss competitions.
- Weighted points.
- Drop competitions.
- Spoon competitions.
- Daily streak competitions.

## 20. Competition creation permissions

Competitions may be created by:

- Server administrators.
- Members with an optional configured competition-manager role.

Users without the necessary permission may still:

- View competitions.
- Join eligible competitions.
- View standings.
- Submit claims for competitions they have entered.

## 21. Competition participation

Users may join a draft competition themselves.

The competition creator or manager may also add participants manually.

Participants may leave before the competition starts.

The competition creator or manager may remove participants before the competition starts.

Membership locks when the competition begins.

After the competition starts:

- Participants cannot join.
- Participants cannot leave.
- Contributing accounts cannot be added or removed.

## 22. Multi-account competition scoring

Competition scoring is primarily per Discord entrant, not per individual linked account.

A Discord user may select multiple linked accounts before the competition begins.

The bot records a starting value for every selected account.

During the competition, the Discord user may play freely on any selected account.

The entrant’s competition score is the sum of the gains across all selected accounts.

Example:

- CrazyNikki: +100 Abyssal Sire KC
- DaddyNikki: +50 Abyssal Sire KC
- Nikki’s combined score: +150 KC

The competition leaderboard gives the Discord entrant one combined position.

Watchlist accounts participate as standalone entrants unless a future specification introduces explicit grouping.

## 23. Competition lifecycle

A competition may have these states:

- Draft
- Start Pending
- Active
- Finish Pending
- Finished
- Cancelled

Multiple competitions may exist simultaneously in one server.

Competition names must be unique within that server.

Finished and cancelled competitions remain viewable as history.

## 24. Starting competitions

Competitions may start:

- Manually.
- Automatically at a scheduled time.

Every selected contributing account must have a trustworthy starting value before the competition becomes active.

If any starting fetch fails:

1. The bot retries once after a short delay.
2. The competition enters `START_PENDING`.
3. The bot records the problem in the administrative channel.
4. The bot retries at a restrained interval, such as every 10 minutes.
5. The competition starts only when all starting values succeed or an administrator cancels it.

The actual successful snapshot time becomes the real competition start time.

If the start is delayed, the competition’s finish time is shifted by the same amount so the intended duration remains unchanged.

## 25. Competition scheduling and timezones

Each competition stores its own timezone.

The default is the Discord server’s configured timezone.

The initial default server timezone is `Europe/Helsinki`, but each server may change it.

Discord-native timestamps should be used so scheduled times display correctly for each user’s local timezone.

## 26. Finishing timed competitions

Timed competitions may finish:

- Manually.
- Automatically at the configured deadline.

When a final-value fetch fails:

- The bot retries once.
- The competition does not declare a potentially incorrect winner.
- The competition remains active or enters `FINISH_PENDING`.
- The problem is reported in the administrative channel.
- Finalization is retried until successful or manually resolved.

If the bot is offline at the adjusted deadline:

- It fetches final values when it returns.
- It marks the result as delayed.
- It explains that gains after the intended deadline may have been included because exact historical Jagex values were unavailable.

## 27. Target-race claims

Target races do not use constant polling.

A participant submits a claim through a competition claim command.

The bot records the claim receipt time in UTC and assigns a stable claim ID
before fetching Hiscores.

The bot then:

1. Finds all selected contributing accounts for the entrant.
2. Fetches fresh current values directly from the hiscore service, bypassing the normal short-lived lookup cache.
3. Compares them with stored starting values.
4. Combines their gains.
5. Verifies whether the target has been reached.

The earliest successfully verified claim wins. When multiple concurrent claims
are valid, the earliest receipt time wins. If receipt timestamps are identical,
the stable claim ID is the deterministic tie-breaker.

The competition is therefore defined as:

> First valid claim after reaching the target.

If the target has not been reached, the bot responds privately with:

- Current progress.
- Required target.
- Remaining amount.

A target race may have an optional deadline.

- A claim received after the stored deadline cannot win.
- A claim received on or before the deadline may finish verification after
  the deadline.

If nobody submits a successful claim before the deadline:

- The competition finishes without a winner.
- Final progress standings are still displayed.

## 28. Competition standings

Anyone in the server may view active competition standings.

The default standings display:

- Entrant’s combined score.
- Contributing account breakdown.
- Current rank.
- Deadline or target.

A detailed slash-command view may additionally display:

- Starting values.
- Current values.
- Per-account gains.

Entrants with equal progress share the same rank.

If one contributing account fails during a progress check:

- Other successful accounts still contribute.
- The failed account uses its last known competition value.
- The bot warns that the entrant’s score may be incomplete.

## 29. Competition Discord roles

When possible, OSLeaders creates a temporary Discord role for each competition.

The role:

- Is assigned to present Discord members who join the competition.
- Is removed when they leave before the competition begins.
- Has locked membership after the competition starts.
- Is mentioned only for important competition events.

Important notifications may include:

- Competition start.
- Delayed start.
- Adjusted deadline.
- Cancellation.
- Successful target claim.
- Timed competition finish.
- Important schedule or availability problems.

The role is not pinged for:

- Normal standings requests.
- Daily recap posts.
- Routine progress checks.

When the competition finishes or is cancelled:

- The bot posts the final notification.
- Removes the role from members.
- Deletes the temporary role.

Watchlist accounts and absent members cannot receive the role.

If role permissions are unavailable:

- The competition still works.
- The creator is warned.
- The problem is logged.

## 30. Daily recap

Each server may configure one automatic daily recap.

The configuration includes:

- Recap channel.
- Recap time.
- Timezone.
- Enabled or disabled status.

The recap is change-only.

It groups results by:

1. Discord user.
2. Linked OSRS account and game mode.
3. Changed skills and bosses.

Watchlist accounts appear in a separate watchlist section.

The recap displays only:

- Positive skill XP gains.
- Positive level gains.
- Positive boss KC gains.

It never displays:

- Zero XP gain.
- Zero level gain.
- Zero KC gain.
- Unchanged accounts.
- Unchanged Discord users.

Example:

Nikki

CrazyNikki — Main
• Magic: +100,000 XP, +1 level → 88
• Kraken: +10 KC

DaddyNikki — Ironman
• Crafting: +500,000 XP, +3 levels → 90

### Skill levels and experience

The OSRS hiscore response provides both the current level and total experience
for each skill.

Daily recap calculations use:

- XP gained = current XP − baseline XP
- Levels gained = current level − baseline level

The hiscore response is the primary source for normal skill levels.

The exact OSRS experience formula and thresholds may be implemented locally
for validation, fallback calculations, testing, or future virtual-level
support. The first version displays normal levels only and does not display
virtual levels above 99.

## 31. Daily recap baseline

Each tracked account stores one rolling recap baseline representing the latest complete known state.

The baseline includes:

- Skill XP.
- Skill levels.
- Boss KC values.
- Last successful capture time.

At recap time, the bot:

1. Loads the stored baseline.
2. Requests a fresh and complete hiscore result.
3. Validates that the result contains the expected complete account data.
4. Calculates positive changes and produces the recap.
5. Replaces the previous baseline with the new complete state and capture time.

If the account fetch fails or returns incomplete data:

- No changes are calculated for that account.
- The complete previous baseline is retained unchanged.
- The failure is reported separately.

A recap baseline is therefore updated atomically per account. It must not contain skill or boss values captured at different times under one shared timestamp.

Historical daily snapshots are not retained.

Weekly and historical recap reports are outside the first version.

## 32. Failed recap fetches

A failed account fetch does not block the entire daily recap.

When one account fails:

- Other accounts are still included.
- The failed account’s baseline is not overwritten.
- The failure is reported separately.
- The administrative channel receives a technical summary.

If the account succeeds on a later day, the bot must make clear that the comparison covers the time since the previous successful snapshot rather than pretending it represents exactly one day.

## 33. No-activity recap

If nobody has tracked gains, the bot still posts a short recap.

Example:

> No tracked XP or boss KC gains since the previous recap.

The active-competition section may still contain useful current standings.

## 34. Active competitions in daily recap

The bottom of the daily recap contains a compact section for every active competition.

The bot reuses the same hiscore data fetched for the daily recap whenever possible.

For timed competitions, the recap shows:

- Competition name.
- Metric.
- Current top entrants.
- Current gains.
- Deadline.

For target races, the recap shows:

- Competition name.
- Target.
- Current closest entrants.
- Current progress.

The daily recap does not automatically declare a target-race winner.

When an entrant has reached the target but has not claimed it, the recap may state that they are eligible to claim.

The competition section should remain compact, normally showing the top three entrants and directing users to the full standings command.

## 35. Delayed daily recaps

If the bot is offline at recap time:

- It posts the recap after returning online.
- It uses the actual current fetch time.
- It shows the real comparison period.
- It does not pretend that the recap covered exactly 24 hours.

## 36. Manual recap commands

The first version supports:

### Recap preview

- Calculates the current recap.
- Shows it privately to the requester.
- Does not post publicly.
- Does not update stored baselines.

### Recap send

- Restricted to authorized administrators or bot managers.
- Requires explicit confirmation because it advances the recap baselines.
- Requests fresh hiscore data rather than relying on the normal lookup cache.
- Posts the recap to the configured channel.
- Updates the rolling baselines only for accounts with complete successful results.

## 37. Response formatting

Structured successful responses use Discord embeds.

This includes:

- Account summaries.
- Player stats.
- Permanent leaderboards.
- Competition standings.
- Competition results.
- Daily recaps.

Short confirmations and errors may use plain messages.

Account modes always include a text label.

Custom mode emojis may be configured, but missing emojis must never make the response unclear.

Long responses are split into numbered embeds or messages.

No valid data should be silently omitted only because one message is too long.

## 38. Ephemeral responses

Appropriate slash-command responses are ephemeral.

Examples include:

- Invalid input.
- Permission errors.
- Failed registration.
- Failed target claim.
- Recap preview.
- Server configuration.
- Administrative confirmations.

Public responses include:

- Successful registration.
- Player statistics.
- Permanent leaderboards.
- Competition standings.
- Successful target claims.
- Competition results.
- Daily recaps.

Administrators cannot see another user’s ephemeral response.

Important events are instead recorded separately in the configured administrative channel.

## 39. Administrative log channel

Each server may configure a private administrative log channel.

The first version supports two logging modes.

### Standard mode

Records:

- Errors.
- Permission failures.
- Registrations.
- Account edits and deletions.
- Account reassignment.
- Competition creation, start, finish and cancellation.
- Recap and scheduling failures.
- Role-management failures.
- Important configuration changes.

### Verbose mode

Records everything in Standard mode, plus:

- Every command invocation.
- Whether it succeeded or failed.
- Command duration.
- Sanitized resolved arguments.
- Input normalization when useful.

Development and troubleshooting may use Verbose mode.

Normal production may use Standard mode.

The bot must never send the following to Discord logs:

- Discord tokens.
- Database credentials.
- Environment-variable secrets.
- Full stack traces.
- Sensitive ephemeral content.

User-facing errors and admin-channel summaries should include a short error-reference ID.

Full technical details remain in local application or system logs.

## 40. Hiscore reliability

Successful hiscore results are cached for one minute for ordinary non-critical lookups and standings.

Cache entries must distinguish at least:

- Normalized OSRS username.
- Hiscore-fetching mode or endpoint.

Operations that create, advance or finalize stored snapshots must request fresh hiscore data and bypass the normal cache. These operations include:

- Initial recap baseline creation.
- Competition starting snapshots.
- Competition finishing snapshots.
- Target-race claims.
- Automatic daily recap collection.
- Manual recap sending.

Temporary hiscore failures are retried once after a short delay.

The bot must avoid aggressive repeated requests.

A failed external request must not crash the Discord bot.

## 41. Cooldowns

Potentially expensive commands use a short per-user cooldown.

The initial default is approximately three seconds.

The cooldown should prevent spam without interfering with normal use.

Recently cached results may still be reused.

Administrative interaction workflows do not necessarily require the same cooldown.

## 42. Persistent storage

PostgreSQL stores persistent application data, including:

- Server configuration.
- Linked accounts.
- Watchlist accounts.
- Default-account selection.
- Rolling recap baselines.
- Competitions.
- Competition entrants.
- Contributing accounts.
- Starting values.
- Latest successfully observed competition values and their observation times.
- Final values.
- Competition results.
- Historical cancelled and finished competition summaries.

The database does not store:

- One-time lookup accounts.
- Every intermediate leaderboard check.
- Every daily historical snapshot.
- Every hiscore response.
- Every progress fetch.

For an active competition account, only the starting value, latest successfully observed value and timestamp, and final value are retained. A new successful progress check replaces the previous rolling latest-known value instead of creating a full progress history.

## 43. Production backups

Production deployment must create automatic rotating PostgreSQL backups.

Backups must protect:

- Account registrations.
- Server configuration.
- Recap baselines.
- Competition history.

The retention schedule and backup location will be defined during deployment architecture.

## 44. Development and deployment environments

The complete application must be developable and testable on the developer’s Windows desktop.

Development does not require the production laptop.

Development uses:

- A separate Discord bot application.
- A separate development database.
- Local environment variables.
- Automated tests.
- Manual Discord testing.

Production uses:

- A separate production Discord bot application.
- A separate production PostgreSQL database.
- Debian 13 Stable.
- No desktop environment.
- SSH administration.
- systemd process management.

Secrets must never be committed to source control.

## 45. First-version non-goals

The first version does not include:

- Dink integration.
- Drop tracking.
- Spoon calculations.
- Team competitions.
- Combined-skill competitions.
- Multi-boss competitions.
- Weighted scoring.
- Weekly recaps.
- Historical daily recap browsing.
- Web dashboard.
- Public multi-user website.
- RuneScape ownership verification.
- Continuous target-race polling.
- Automated interpretation of screenshots.
- Public large-scale bot distribution.
- Configurable command-only channels.

## 46. Product-level acceptance criteria

The first complete version is acceptable when:

1. A server can register linked and watchlist OSRS accounts.
2. Game modes are selected through guided Discord components.
3. Invalid usernames and verifiably invalid account-mode combinations are rejected.
4. One Discord user can manage multiple linked accounts.
5. Default-account behaviour works.
6. Server data is isolated from other servers.
7. Skill and boss lookups work for tracked accounts.
8. One-time unregistered lookups work without saving data.
9. Discord mentions return all linked accounts for the selected member.
10. Permanent skill leaderboards sort by XP.
11. Permanent boss leaderboards sort by KC.
12. Linked and watchlist accounts appear correctly.
13. All four competition types can be created and completed.
14. Multiple selected accounts combine into one Discord entrant score.
15. Timed competitions preserve their intended duration after delayed starts.
16. Target races use first-valid-claim-wins behaviour.
17. Competitions survive bot restarts.
18. Competition roles notify present Discord participants about important events.
19. Daily recaps contain only positive changes.
20. Daily recaps use one rolling baseline per tracked account.
21. Daily recaps include compact active-competition standings.
22. Failed account fetches do not erase baselines or block unrelated results.
23. Admin logging provides useful error references without exposing secrets.
24. Deleted registrations do not destroy finished competition history.
25. Long results are split rather than silently truncated.
26. Appropriate commands use short cooldowns and one-minute caching.
27. Development and production use separate bots and databases.
28. Automated tests verify core account, leaderboard, competition and recap behaviour.
29. The production bot runs continuously on the headless Debian laptop.
30. Production PostgreSQL data is backed up automatically.

## 47. Reference material

These pages are reference material for design and implementation. OSLeaders does not query the wiki during normal bot operation.

- Old School Hiscores API overview and endpoint reference: https://runescape.wiki/w/Application_programming_interface#Old_School_Hiscores
- OSRS experience formula and level thresholds: https://oldschool.runescape.wiki/w/Experience
