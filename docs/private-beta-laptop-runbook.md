# Debian private-beta laptop runbook

This runbook operates one real OSLeaders bot for one private Discord server on
a headless Debian 13 laptop administered through SSH. Windows is only the
development environment and must use its own Discord application and database.
This is an early private beta, not a claim that the full v1 feature set is
finished.

## Separate the real bot from development

The Debian laptop must have its own Discord application, bot token, guild ID,
PostgreSQL role, and PostgreSQL database. Do not copy the Windows `.env` file.
The real bot uses `NODE_ENV=production` and `DISCORD_PRODUCTION_GUILD_ID`; the
Windows development bot uses `NODE_ENV=development` and
`DISCORD_DEVELOPMENT_GUILD_ID`.

## One-time Debian setup

1. Install Node.js 24, npm 11, Git, PostgreSQL, and the PostgreSQL client
   tools. Verify the installed Node.js and npm versions satisfy `package.json`.
2. Create an unprivileged `osleaders` system user and a checkout at
   `/opt/osleaders` owned by that user. Install dependencies and build while
   logged in as that user:

   ```sh
   cd /opt/osleaders
   npm ci
   npm run build
   ```

3. Configure PostgreSQL to listen only on loopback. Create a dedicated role and
   a production database with a name other than `osleaders_dev` and
   `osleaders_test`. Do not use the Windows development database.
4. Create `/etc/osleaders/osleaders.env` from
   [`.env.production.example`](../.env.production.example). Set ownership to
   `root:osleaders` and mode `0640`. Use the production Discord application,
   token, guild ID, and local production database URL.
5. Apply reviewed migrations explicitly, before starting a new version:

   ```sh
   cd /opt/osleaders
   set -a; . /etc/osleaders/osleaders.env; set +a
   npm run db:migrate:production
   ```

   This command refuses `osleaders_dev` and `osleaders_test`. It never runs
   automatically when the bot starts.

6. Invite the production bot to the one private guild with the `bot` and
   `applications.commands` scopes. Give it View Channel, Send Messages, Embed
   Links, Read Message History, and Use Application Commands in every channel
   it needs, including recap and optional administrative-log channels. Do not
   grant Discord Administrator unless that is intentional.
7. Register the current commands in the production guild:

   ```sh
   cd /opt/osleaders
   set -a; . /etc/osleaders/osleaders.env; set +a
   npm run discord:commands
   ```

## Continuous bot process

Install the reviewed unit, reload systemd, and enable it at boot:

```sh
sudo install -o root -g root -m 0644 deploy/systemd/osleaders.service /etc/systemd/system/osleaders.service
sudo systemctl daemon-reload
sudo systemctl enable --now osleaders.service
sudo systemctl status osleaders.service
sudo journalctl -u osleaders.service -f
```

The unit runs only the single Node.js process as `osleaders`, restarts a failed
process after 30 seconds, and lets the application close Discord and PostgreSQL
cleanly on shutdown. It does not start migrations or store secrets in the unit.

For a planned update: stop the service, create and verify a backup, install the
reviewed version, run `npm ci` and `npm run build`, apply reviewed migrations,
re-register commands if they changed, start the service, and repeat the restart
checks below. Never run `db:test:reset` on the Debian laptop.

## Deferred backups and restore rehearsal

Backups and restore rehearsal are intentionally deferred for this small,
private beta. The operator accepts that a laptop or database failure can lose
the bot's stored data. Do not install or enable the backup system merely to
operate the current bot.

The reviewed backup assets remain in the repository for possible future public,
paid, or larger-community deployment. At that point, choose already-owned
storage mounted outside the laptop's internal disk, such as an encrypted USB
drive, then follow the retained procedure below.

Create `/etc/osleaders/backup.env`, owned by `root:osleaders` with mode `0640`:

```sh
OSLEADERS_BACKUP_DIRECTORY=/mnt/osleaders-backups
OSLEADERS_BACKUP_MOUNT=/mnt/osleaders-backups
OSLEADERS_BACKUP_RETENTION_DAYS=14
```

The destination must already exist and `findmnt -T` must report exactly the
configured mount point. This makes an absent external drive fail the backup
instead of silently writing to the laptop disk.

Create `/etc/osleaders/postgres.pgpass` with the single private line
`host:port:database:user:password` matching the production database URL. Set
its ownership to `osleaders:osleaders` and mode to `0600`. The backup service
sets `PGPASSFILE` to this path explicitly, because its `ProtectHome=true`
hardening deliberately makes `~osleaders/.pgpass` unavailable. PostgreSQL
tools obtain the password from this file without putting a password or
connection URL on a command line.

Install the backup service and daily timer:

```sh
sudo install -o root -g root -m 0644 deploy/systemd/osleaders-backup.service /etc/systemd/system/osleaders-backup.service
sudo install -o root -g root -m 0644 deploy/systemd/osleaders-backup.timer /etc/systemd/system/osleaders-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now osleaders-backup.timer
sudo systemctl start osleaders-backup.service
sudo systemctl status osleaders-backup.service
sudo systemctl list-timers osleaders-backup.timer
```

The backup script produces a PostgreSQL custom-format dump, verifies it with
`pg_restore --list`, and removes only expired `osleaders-<database>-*.dump`
files in the configured external directory. Check the service result after the
first run and whenever the external storage is reconnected.

For a restore rehearsal, stop the bot and restore a verified dump into a new,
differently named database. The script refuses the database named by the live
configuration and refuses to overwrite an existing database:

```sh
sudo systemctl stop osleaders.service
sudo -u osleaders env PGPASSFILE=/etc/osleaders/postgres.pgpass bash /opt/osleaders/scripts/restore-private-beta-rehearsal.sh \
  --backup-path /mnt/osleaders-backups/osleaders-EXAMPLE-YYYY-MM-DD-HHMMSS.dump \
  --rehearsal-database osleaders_restore_rehearsal \
  --environment-file /etc/osleaders/osleaders.env
sudo systemctl start osleaders.service
```

Afterward, verify `/etc/osleaders/osleaders.env` still targets the live
database. Never restore over the live database unless recovering from a
confirmed failure with a current verified backup.

## Real-server acceptance checklist

Complete and record the applicable checks on the Debian laptop before
describing the bot as ready for continuous private-beta use without backup or
restore guarantees:

1. Confirm the existing linked and watchlist accounts have fetchable Hiscores;
   do not create synthetic accounts in the live guild solely for this check.
2. Confirm `/skill`, `/boss`, `/one-time-skill`, `/one-time-boss`,
   `/skill-leaderboard`, and `/boss-leaderboard` work in the production guild.
3. Configure a near-future recap using `/recap configure`; confirm `/recap
preview` remains private, then use the confirmed `/recap send` flow and
   confirm delivery to the configured channel.
4. With `osleaders.service` running, stop only the Node process. Confirm
   systemd restarts it after 30 seconds, commands still work, and data remains.
5. Let an automatic recap become due after the restart. Confirm one recap is
   posted, its comparison wording uses the saved baseline, and a retry or
   restart does not corrupt that baseline.
6. Do not deliberately make a live tracked account unavailable. When a natural
   Hiscores failure occurs, confirm other accounts still appear and the
   configured administrative log receives the failure summary.
7. Record dates, restart behavior, recap duration, and any observed Hiscores
   failures in private operator notes.

The private beta is ready for continuous use only after the applicable checks
succeed on the real Debian laptop. This readiness deliberately excludes backup
and restore guarantees. Passing automated tests or installing these units does
not replace the checklist.
