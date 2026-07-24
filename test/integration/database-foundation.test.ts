import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadTestDatabaseConfiguration } from '../../src/infrastructure/config/database-environment.js';
import {
  createDatabaseConnection,
  type DatabaseConnection,
  withTransaction,
} from '../../src/infrastructure/database/connection.js';
import { PostgresGuildConfigurationRepository } from '../../src/infrastructure/database/postgres-guild-configuration-repository.js';
import { guildConfigurations, guilds } from '../../src/infrastructure/database/schema/index.js';

let connection: DatabaseConnection;

interface DrizzleJournal {
  entries: {
    tag: string;
    when: number;
  }[];
}

beforeAll(() => {
  connection = createDatabaseConnection({
    ...loadTestDatabaseConfiguration(),
    poolMax: 1,
  });
});

afterAll(async () => {
  await connection.close();
});

describe('database foundation', () => {
  it('connects to PostgreSQL', async () => {
    const result = await connection.pool.query<{ connected: number }>('SELECT 1 AS connected');

    expect(result.rows).toEqual([{ connected: 1 }]);
  });

  it('applies the committed database migrations to an empty test database', async () => {
    const committedMigrations = await readCommittedMigrations();
    const applicationTables = await connection.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('guild_configurations', 'guilds') ORDER BY table_name",
    );
    const migrationTables = await connection.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'",
    );
    const migrationRecords = await connection.pool.query<{ created_at: string; hash: string }>(
      'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at',
    );

    expect(applicationTables.rows).toEqual([
      { table_name: 'guild_configurations' },
      { table_name: 'guilds' },
    ]);
    expect(migrationTables.rows).toEqual([{ table_name: '__drizzle_migrations' }]);
    expect(migrationRecords.rows).toEqual(committedMigrations);
  });

  it('commits a successful transaction', async () => {
    const guildId = 'integration-commit-guild';

    await withTransaction(connection.database, async (transaction) => {
      await transaction.insert(guilds).values({ guildId });
    });

    const result = await connection.database.execute(
      sql`SELECT guild_id FROM guilds WHERE guild_id = ${guildId}`,
    );

    expect(result.rows).toEqual([{ guild_id: guildId }]);
  });

  it('rolls back a failed transaction', async () => {
    const guildId = 'integration-rollback-guild';

    await expect(
      withTransaction(connection.database, async (transaction) => {
        await transaction.insert(guilds).values({ guildId });
        throw new Error('Force transaction rollback.');
      }),
    ).rejects.toThrow('Force transaction rollback.');

    const result = await connection.database.execute(
      sql`SELECT guild_id FROM guilds WHERE guild_id = ${guildId}`,
    );

    expect(result.rows).toEqual([]);
  });

  it('stores configuration independently for each guild and allows nullable settings to be cleared', async () => {
    const repository = new PostgresGuildConfigurationRepository(connection.database);

    await expect(repository.getOrCreate('configuration-guild-one')).resolves.toEqual({
      administrativeLogChannelId: null,
      administrativeLogMode: 'standard',
      botManagerRoleId: null,
      competitionManagerRoleId: null,
      guildId: 'configuration-guild-one',
    });
    await repository.update('configuration-guild-one', {
      administrativeLogChannelId: 'audit-channel-one',
      administrativeLogMode: 'verbose',
      botManagerRoleId: 'bot-manager-one',
    });
    await repository.update('configuration-guild-two', {
      competitionManagerRoleId: 'competition-manager-two',
    });
    const [beforeClear] = await connection.database
      .select()
      .from(guildConfigurations)
      .where(eq(guildConfigurations.guildId, 'configuration-guild-one'));
    if (beforeClear === undefined) {
      throw new Error('Expected the first guild configuration to exist.');
    }

    await waitForClockTick(beforeClear.updatedAt);
    await repository.update('configuration-guild-one', {
      administrativeLogChannelId: null,
      botManagerRoleId: null,
    });

    await expect(repository.getOrCreate('configuration-guild-one')).resolves.toMatchObject({
      administrativeLogChannelId: null,
      administrativeLogMode: 'verbose',
      botManagerRoleId: null,
      competitionManagerRoleId: null,
    });
    await expect(repository.getOrCreate('configuration-guild-two')).resolves.toMatchObject({
      administrativeLogChannelId: null,
      administrativeLogMode: 'standard',
      botManagerRoleId: null,
      competitionManagerRoleId: 'competition-manager-two',
    });

    const configurationRows = await connection.database.select().from(guildConfigurations);
    expect(configurationRows).toHaveLength(2);
    const clearedConfiguration = configurationRows.find(
      ({ guildId }) => guildId === 'configuration-guild-one',
    );
    expect(clearedConfiguration?.updatedAt.getTime()).toBeGreaterThan(
      beforeClear.updatedAt.getTime(),
    );
  });
});

async function readCommittedMigrations(): Promise<{ created_at: string; hash: string }[]> {
  const journalFile = new URL('../../drizzle/meta/_journal.json', import.meta.url);
  const journal = JSON.parse(await readFile(journalFile, 'utf8')) as DrizzleJournal;

  return Promise.all(
    journal.entries.map(async (entry) => {
      const migrationFile = new URL(`../../drizzle/${entry.tag}.sql`, import.meta.url);
      const migrationSql = await readFile(migrationFile, 'utf8');
      return {
        created_at: String(entry.when),
        hash: createHash('sha256').update(migrationSql).digest('hex'),
      };
    }),
  );
}

async function waitForClockTick(previousTime: Date): Promise<void> {
  while (Date.now() <= previousTime.getTime()) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}
