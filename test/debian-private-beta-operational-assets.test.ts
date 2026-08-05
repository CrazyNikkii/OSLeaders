import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const repositoryFile = (path: string) => new URL(`../${path}`, import.meta.url);

describe('Debian private-beta operational assets', () => {
  it('keeps the bot under a restrained, unprivileged systemd service', async () => {
    const service = await readFile(repositoryFile('deploy/systemd/osleaders.service'), 'utf8');

    expect(service).toContain('User=osleaders');
    expect(service).toContain('EnvironmentFile=/etc/osleaders/osleaders.env');
    expect(service).toContain('ExecStart=/usr/bin/node /opt/osleaders/dist/main.js');
    expect(service).toContain('Restart=on-failure');
    expect(service).toContain('RestartSec=30s');
    expect(service).toContain('NoNewPrivileges=true');
  });

  it('requires an external mounted destination and validates each backup', async () => {
    const script = await readFile(
      repositoryFile('scripts/backup-private-beta-database.sh'),
      'utf8',
    );

    expect(script).toContain('findmnt --target "$destination_directory"');
    expect(script).toContain('pg_dump --format=custom');
    expect(script).toContain('pg_restore --list "$backup_path"');
    expect(script).toContain('DATABASE_URL must target local PostgreSQL');
    expect(script).not.toContain('--dbname=$DATABASE_URL');
  });

  it('refuses a restore rehearsal against the live database', async () => {
    const script = await readFile(
      repositoryFile('scripts/restore-private-beta-rehearsal.sh'),
      'utf8',
    );

    expect(script).toContain('[[ "$rehearsal_database" != "$runtime_database" ]]');
    expect(script).toContain('createdb --maintenance-db=postgres');
    expect(script).toContain('pg_restore --no-owner --exit-on-error');
    expect(script).toContain("to_regclass('public.guilds')");
  });

  it('runs backups through a persistent daily systemd timer', async () => {
    const [service, timer] = await Promise.all([
      readFile(repositoryFile('deploy/systemd/osleaders-backup.service'), 'utf8'),
      readFile(repositoryFile('deploy/systemd/osleaders-backup.timer'), 'utf8'),
    ]);

    expect(service).toContain('EnvironmentFile=/etc/osleaders/backup.env');
    expect(service).toContain('Environment=PGPASSFILE=/etc/osleaders/postgres.pgpass');
    expect(service).toContain('ProtectHome=true');
    expect(service).toContain(
      'ExecStart=/usr/bin/env bash /opt/osleaders/scripts/backup-private-beta-database.sh',
    );
    expect(timer).toContain('OnCalendar=*-*-* 03:15:00');
    expect(timer).toContain('Persistent=true');
  });

  it('keeps PostgreSQL credentials outside the protected service home directory', async () => {
    const runbook = await readFile(repositoryFile('docs/private-beta-laptop-runbook.md'), 'utf8');

    expect(runbook).toContain('/etc/osleaders/postgres.pgpass');
    expect(runbook).toContain('ownership to `osleaders:osleaders` and mode to `0600`');
    expect(runbook).toContain('ProtectHome=true');
    expect(runbook).toContain('PGPASSFILE=/etc/osleaders/postgres.pgpass');
  });
});
