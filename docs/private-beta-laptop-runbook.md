# Private-beta laptop runbook

This runbook is for one private Discord server on the current Windows laptop.
It uses the existing single-process Node.js application and local PostgreSQL
database. It is deliberately not a claim that OSLeaders has a finished
multi-server production deployment.

## What this setup does

For example, a server owner can register `Nikki` and `Friend`, configure a
recap for 20:00 in `Europe/Helsinki`, and leave the laptop running. The bot
checks for the scheduled recap, fetches current Hiscores, posts the recap, and
keeps the account baseline needed for tomorrow's comparison. If the laptop is
restarted, the bot reconnects and resumes its durable recap work.

## One-time setup

1. Install the Node.js and npm versions required by `package.json`, PostgreSQL,
   and the project dependencies with `npm ci`.
2. Copy `.env.example` to `.env`. Keep it out of Git. Set
   `NODE_ENV=development`, the local private-beta database URL, the Discord
   application ID and token, and the ID of the one private server in
   `DISCORD_DEVELOPMENT_GUILD_ID`.
3. Apply the reviewed migration files with `npm run db:migrate`. Do this before
   starting a new application version; starting the bot never applies migrations
   automatically.
4. Invite the bot to that one server with the `bot` and
   `applications.commands` scopes. Grant it View Channel, Send Messages, Embed
   Links, Read Message History, and Use Application Commands in the channels it
   will use. It also needs access to the recap and optional administrative-log
   channels. Do not grant Administrator unless that is the server's intended
   bot permission model.
5. Run `npm run discord:commands:development` after every slash-command
   change, then run `npm run dev` once to confirm the bot logs in and connects
   to PostgreSQL.

The bot ignores interactions from every guild except the configured guild.
Keep that ID set to the private server, not a broad shared test server.

## Keep it running after sign-in and restart

Use Windows Task Scheduler to run the included local watchdog when the
dedicated laptop user signs in. The watchdog runs `npm run dev`, waits one
minute after any exit, and continues relaunching it until the scheduled task is
explicitly stopped. Configure the task manually so secrets remain only in the
protected `.env` file:

1. Create a task named `OSLeaders private beta` for the Windows user that owns
   the checkout and `.env` file. Use **Run only when user is logged on**.
2. Trigger it **At log on** for that user, with a one-minute delay.
3. Set **Start in** to the project directory. In the task's **Action** fields,
   set **Program/script** to `powershell.exe` and **Add arguments** to
   `-NoProfile -ExecutionPolicy Bypass -File scripts\run-private-beta-runtime.ps1`.
   Do not place the Discord token or database URL in either field.
4. Set the task not to start a new instance when it is already running. The
   watchdog, not a finite Task Scheduler retry count, provides durable relaunch
   after a bot-process exit.
5. Enable the laptop's normal automatic sign-in only if the user accepts that
   Windows security trade-off. Otherwise, after a reboot, sign in once and
   confirm the task is running.

To make a planned update: stop the task, take a backup, pull or install the
reviewed version, apply reviewed migrations, re-register Discord commands if
they changed, start the task, and complete the restart checks below. Never use
the guarded `db:test:reset` command against the private-beta database.

## Backup and restore

Before every migration and at least daily, create a PostgreSQL custom-format
backup with the included backup command. Store it on already-owned external
storage (for example, an encrypted USB drive or an existing personal cloud
folder), not only another folder on the laptop disk. Keep several dated backups
and check that the external location is still receiving new files.

Create `%APPDATA%\postgresql\pgpass.conf` for the Windows account that runs the
tasks. Its one private line is `host:port:database:user:password`, matching the
host, port, database, and user in `DATABASE_URL`; restrict that file so other
Windows accounts cannot read it. PostgreSQL command-line tools use this file
for the password. From a PowerShell session where PostgreSQL tools are
available, the scripts read `DATABASE_URL` only to obtain its non-secret host,
port, user, and database values. They never place the URL or password on a
PostgreSQL command line. Both scripts refuse any host other than `localhost`,
`127.0.0.1`, or `::1` before invoking a PostgreSQL tool.

```powershell
powershell -NoProfile -File scripts\backup-private-beta-database.ps1 `
  -DestinationDirectory "E:\OSLeadersBackups"
```

Replace the example drive with the actual private-beta backup drive. The command
refuses a missing destination, creates a dated backup of the configured runtime
database, and checks that `pg_restore` can read it. If PostgreSQL tools are not
on the path, pass `-PostgreSqlBinDirectory` with the local PostgreSQL `bin`
folder.

Create a second Task Scheduler task to run that command daily. Use the same
Windows user that owns `pgpass.conf`, set it not to overlap itself, and enable
task history. Set **Program/script** to `powershell.exe`, **Add arguments** to
`-NoProfile -ExecutionPolicy Bypass -File scripts\backup-private-beta-database.ps1
-DestinationDirectory "E:\OSLeadersBackups"`, and **Start in** to the project
directory. A missing external drive must cause the task to fail rather than
silently storing a backup somewhere else; check the task result after the first
run and whenever the external storage is reconnected.

For a restore rehearsal, stop the bot and restore into a newly created database
whose name is different from the database in `DATABASE_URL`:

```powershell
powershell -NoProfile -File scripts\restore-private-beta-rehearsal.ps1 `
  -BackupPath "E:\OSLeadersBackups\osleaders-osleaders_dev-YYYY-MM-DD-HHMMSS.dump" `
  -RehearsalDatabaseName osleaders_restore_rehearsal
```

The restore command creates the new rehearsal database through the configured
PostgreSQL host and user, refuses to use the live configured database name,
restores with `pg_restore --no-owner --exit-on-error`, and confirms that the
`guilds` and `daily_recap_runs` tables exist. It refuses an already existing
rehearsal database instead of overwriting it. After the rehearsal, confirm the
live `.env` still names the original database before restarting the bot. Do not
restore over the live database unless recovering from a confirmed failure and a
current backup exists.

## Real-server acceptance checklist

Complete this checklist on the configured private server before describing the
bot as ready for continuous private-beta use:

1. Record the database backup location and create a verified backup.
2. Register one linked and one watchlist account with fetchable Hiscores.
3. Confirm `/skill`, `/boss`, `/one-time-skill`, `/one-time-boss`,
   `/skill-leaderboard`, and `/boss-leaderboard` work in the server.
4. Configure a recap channel and a near-future recap time using `/recap configure`.
   Confirm `/recap preview` stays private. Use the confirmed `/recap send` flow
   once and confirm it posts to the configured channel.
5. While the Task Scheduler watchdog is running, stop only its child Node/npm
   process—not the scheduled task. Confirm it relaunches the bot after one
   minute, then confirm commands still work and database data remains present.
6. Let an automatic recap become due after that restart. Confirm one recap is
   posted, its comparison wording reflects the saved baseline, and a retry or
   restart does not corrupt the baseline.
7. Complete the separate restore rehearsal above and confirm the live `.env`
   still targets the original database before starting the watchdog again.
8. Temporarily make one tracked account unavailable only if safe to do so, then
   confirm other accounts still appear and the configured administrative log
   receives the failure summary. Restore normal operation afterward.
9. Record the actual results, dates, laptop restart behaviour, recap duration,
   and any Hiscores failures in the operator notes.

The private beta is ready only after all nine checks succeed on the real
server. Until then, this document is a preparation and recovery guide, not an
operational-readiness claim.
