# Development Discord testing

Use a separate Discord application, bot token, guild, and local
`osleaders_dev` PostgreSQL database. For the current early private beta, that
configured guild may be the one real private server. Never point the guarded
test-database commands at it.

1. Copy `.env.example` to `.env` and supply the development application ID,
   bot token, and development guild ID. Keep `NODE_ENV=development` and use a
   local `osleaders_dev` database URL.
2. Install the locked dependencies with `npm ci` and apply migrations with
   `npm run db:migrate`.
3. Invite the development bot to the development guild with the `bot` and
   `applications.commands` scopes. It needs permission to view the channel,
   send messages, and use application commands.
4. Run `npm run discord:commands:development`. This registers the current
   commands in only the configured development guild, so command updates are
   available without waiting for global Discord command propagation.
5. Run `npm run dev`. Startup verifies PostgreSQL before logging the bot in;
   stop it with Ctrl+C to close Discord and the database connection.

## Current vertical-slice checklist

1. Run `/account register`, choose a watchlist account, select the correct
   mode, and complete the flow with a real fetchable OSRS username. Confirm the
   public registration message appears and the account persists after restarting
   the bot.
2. Register two linked accounts for yourself. Confirm the first becomes the
   default, then use `/account default` to select the other one.
3. Run `/account remove` for one account. Confirm that the button is required,
   another member cannot use your confirmation, and the replacement default is
   clearly reported when applicable.
4. Attempt a duplicate registration with changed capitalization and confirm it
   is rejected within the same guild.
5. Test an invalid or unavailable username and confirm no account is persisted.
6. Run `/one-time-skill`, enter an unregistered OSRS username, select its mode
   and a skill, and confirm the private result has the expected level,
   experience, rank, and text mode label. Restart the bot and confirm no
   tracked account was created.
7. Run `/skill-leaderboard`, select a skill, and confirm tracked linked and
   watchlist accounts are ranked by XP. Confirm `All` includes more than the
   default top ten when enough accounts are registered.
8. Run `/boss-leaderboard`, use boss autocomplete to select a boss, and confirm
   tracked accounts are ranked by KC. Confirm zero-KC accounts are omitted when
   another account has KC, and `All` includes more than the default top ten
   when enough accounts are registered.
9. Run `/one-time-boss`, enter an unregistered OSRS username, select its mode
   and a boss, then confirm the public result has the expected kill count,
   rank, and text mode label. Restart the bot and confirm no tracked account
   was created.
10. Run `/recap configure`, choose a text channel, a future local time, and the
    server timezone. Run `/recap preview` to confirm it is private and leaves
    baselines unchanged. Then use `/recap send`, confirm it with the button,
    and confirm the recap appears in the configured channel.

For the full laptop startup, backup, recovery, and restart acceptance procedure,
use [the private-beta laptop runbook](private-beta-laptop-runbook.md).

Administrative-log configuration does not yet have a Discord configuration
command, so that optional delivery path remains covered by adapter tests until
the configuration interface is implemented.
