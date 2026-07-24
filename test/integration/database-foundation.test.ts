import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadTestDatabaseConfiguration } from '../../src/infrastructure/config/database-environment.js';
import {
  createDatabaseConnection,
  type DatabaseConnection,
  withTransaction,
} from '../../src/infrastructure/database/connection.js';
import { guilds } from '../../src/infrastructure/database/schema/index.js';

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

  it('applies the guild tenancy migration to an empty test database', async () => {
    const committedMigration = await readCommittedMigration();
    const guildTables = await connection.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'guilds'",
    );
    const migrationTables = await connection.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'",
    );
    const migrationRecords = await connection.pool.query<{ created_at: string; hash: string }>(
      'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at',
    );

    expect(guildTables.rows).toEqual([{ table_name: 'guilds' }]);
    expect(migrationTables.rows).toEqual([{ table_name: '__drizzle_migrations' }]);
    expect(migrationRecords.rows).toEqual([committedMigration]);
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
});

async function readCommittedMigration(): Promise<{ created_at: string; hash: string }> {
  const migrationTag = '0000_database-foundation';
  const migrationFile = new URL(`../../drizzle/${migrationTag}.sql`, import.meta.url);
  const journalFile = new URL('../../drizzle/meta/_journal.json', import.meta.url);
  const migrationSql = await readFile(migrationFile, 'utf8');
  const journal = JSON.parse(await readFile(journalFile, 'utf8')) as DrizzleJournal;
  const journalEntry = journal.entries.find((entry) => entry.tag === migrationTag);

  if (journalEntry === undefined) {
    throw new Error(`The Drizzle journal does not contain ${migrationTag}.`);
  }

  return {
    created_at: String(journalEntry.when),
    hash: createHash('sha256').update(migrationSql).digest('hex'),
  };
}
