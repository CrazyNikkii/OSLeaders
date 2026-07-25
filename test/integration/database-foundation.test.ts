import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadTestDatabaseConfiguration } from '../../src/infrastructure/config/database-environment.js';
import { AccountRetrievalService } from '../../src/features/accounts/account-retrieval.js';
import { AccountAssociationConversionService } from '../../src/features/accounts/convert-account-association.js';
import { MemberPresenceService } from '../../src/features/accounts/member-presence.js';
import { LinkedAccountReassignmentService } from '../../src/features/accounts/reassign-linked-account.js';
import { DefaultAccountSelectionService } from '../../src/features/accounts/select-default-account.js';
import {
  createDatabaseConnection,
  type DatabaseConnection,
  withTransaction,
} from '../../src/infrastructure/database/connection.js';
import { PostgresGuildConfigurationRepository } from '../../src/infrastructure/database/postgres-guild-configuration-repository.js';
import { PostgresAccountRegistrationRepository } from '../../src/infrastructure/database/postgres-account-registration-repository.js';
import {
  guildConfigurations,
  guildMemberPresences,
  guilds,
  recapBaselines,
  trackedAccounts,
} from '../../src/infrastructure/database/schema/index.js';

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
    poolMax: 2,
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
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('guild_configurations', 'guild_member_presences', 'guilds', 'recap_baselines', 'tracked_accounts') ORDER BY table_name",
    );
    const migrationTables = await connection.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'",
    );
    const migrationRecords = await connection.pool.query<{ created_at: string; hash: string }>(
      'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at',
    );

    expect(applicationTables.rows).toEqual([
      { table_name: 'guild_configurations' },
      { table_name: 'guild_member_presences' },
      { table_name: 'guilds' },
      { table_name: 'recap_baselines' },
      { table_name: 'tracked_accounts' },
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

  it('keeps account names guild-scoped and selects the first linked account as default', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);

    const first = await repository.register(account({ id: 'account-one' }), initialRecapBaseline());
    const second = await repository.register(
      account({
        id: 'account-two',
        normalizedUsername: 'other player',
        displayUsername: 'Other Player',
      }),
      initialRecapBaseline(),
    );
    const sameNameOtherGuild = await repository.register(
      account({ id: 'account-three', guildId: 'account-guild-two' }),
      initialRecapBaseline(),
    );
    const duplicate = await repository.register(
      account({ id: 'account-four', registeredByDiscordUserId: 'member-two' }),
      initialRecapBaseline(),
    );

    expect(first).toMatchObject({ kind: 'registered', account: { isDefault: true } });
    expect(second).toMatchObject({ kind: 'registered', account: { isDefault: false } });
    expect(sameNameOtherGuild).toMatchObject({ kind: 'registered' });
    expect(duplicate).toEqual({ kind: 'username_taken' });
    const [baseline] = await connection.database
      .select()
      .from(recapBaselines)
      .where(eq(recapBaselines.accountId, 'account-one'));
    expect(baseline).toMatchObject({
      accountId: 'account-one',
      bossKillCounts: { Zulrah: 12 },
      guildId: 'account-guild-one',
      skillExperience: { Attack: 1234 },
      skillLevels: { Attack: 10 },
    });
  });

  it('serializes concurrent registrations so a member cannot exceed the account quota', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const guildId = 'account-quota-guild';

    for (let index = 0; index < 9; index += 1) {
      await repository.register(
        account({
          id: `quota-existing-${index}`,
          guildId,
          displayUsername: `Quota Player ${index}`,
          normalizedUsername: `quota player ${index}`,
        }),
        initialRecapBaseline(),
      );
    }

    const results = await Promise.all([
      repository.register(
        account({
          id: 'quota-race-one',
          guildId,
          displayUsername: 'Quota Race One',
          normalizedUsername: 'quota race one',
        }),
        initialRecapBaseline(),
      ),
      repository.register(
        account({
          id: 'quota-race-two',
          guildId,
          displayUsername: 'Quota Race Two',
          normalizedUsername: 'quota race two',
        }),
        initialRecapBaseline(),
      ),
    ]);

    expect(results.filter((result) => result.kind === 'registered')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'account_limit_reached')).toHaveLength(1);
    const [countResult] = await connection.database
      .select({ accountCount: sql<number>`count(*)` })
      .from(trackedAccounts)
      .where(eq(trackedAccounts.guildId, guildId));
    expect(Number(countResult?.accountCount)).toBe(10);
  });

  it('serializes concurrent first linked registrations so exactly one becomes default', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const guildId = 'account-default-race-guild';

    const results = await Promise.all([
      repository.register(
        account({
          id: 'default-race-one',
          guildId,
          displayUsername: 'Default Race One',
          normalizedUsername: 'default race one',
        }),
        initialRecapBaseline(),
      ),
      repository.register(
        account({
          id: 'default-race-two',
          guildId,
          displayUsername: 'Default Race Two',
          normalizedUsername: 'default race two',
        }),
        initialRecapBaseline(),
      ),
    ]);

    expect(results.filter((result) => result.kind === 'registered')).toHaveLength(2);
    const defaults = await connection.database
      .select({ id: trackedAccounts.id })
      .from(trackedAccounts)
      .where(and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.isDefault, true)));
    expect(defaults).toHaveLength(1);
  });

  it('retrieves accounts within their guild and atomically changes a linked member default', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const accounts = new AccountRetrievalService(repository);
    const selection = new DefaultAccountSelectionService(repository, repository);
    const guildId = 'account-retrieval-guild';

    await repository.register(
      account({
        id: 'retrieval-account-one',
        guildId,
        displayUsername: 'Retrieval One',
        normalizedUsername: 'retrieval one',
      }),
      initialRecapBaseline(),
    );
    await repository.register(
      account({
        id: 'retrieval-account-two',
        guildId,
        displayUsername: 'Retrieval Two',
        normalizedUsername: 'retrieval two',
      }),
      initialRecapBaseline(),
    );
    await repository.register(
      account({
        id: 'retrieval-account-other-guild',
        guildId: 'account-retrieval-other-guild',
        displayUsername: 'Retrieval Other Guild',
        normalizedUsername: 'retrieval other guild',
      }),
      initialRecapBaseline(),
    );

    await expect(accounts.listForGuild(guildId)).resolves.toHaveLength(2);
    await expect(
      accounts.getById(guildId, 'retrieval-account-other-guild'),
    ).resolves.toBeUndefined();
    await expect(
      selection.select({
        accountId: 'retrieval-account-two',
        canManageAccounts: false,
        guildId,
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toMatchObject({ kind: 'selected', account: { isDefault: true } });
    await expect(accounts.getDefaultForMember(guildId, 'member-one')).resolves.toMatchObject({
      id: 'retrieval-account-two',
      isDefault: true,
    });
    await expect(accounts.getById(guildId, 'retrieval-account-one')).resolves.toMatchObject({
      isDefault: false,
    });
  });

  it('serializes concurrent default selections so a linked member retains exactly one default', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const selection = new DefaultAccountSelectionService(repository, repository);
    const guildId = 'concurrent-default-selection-guild';

    await repository.register(
      account({
        id: 'concurrent-default-selection-one',
        guildId,
        displayUsername: 'Concurrent Default One',
        normalizedUsername: 'concurrent default one',
      }),
      initialRecapBaseline(),
    );
    await repository.register(
      account({
        id: 'concurrent-default-selection-two',
        guildId,
        displayUsername: 'Concurrent Default Two',
        normalizedUsername: 'concurrent default two',
      }),
      initialRecapBaseline(),
    );

    await expect(
      Promise.all([
        selection.select({
          accountId: 'concurrent-default-selection-one',
          canManageAccounts: false,
          guildId,
          requesterDiscordUserId: 'member-one',
        }),
        selection.select({
          accountId: 'concurrent-default-selection-two',
          canManageAccounts: false,
          guildId,
          requesterDiscordUserId: 'member-one',
        }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ kind: 'selected' }),
      expect.objectContaining({ kind: 'selected' }),
    ]);

    const defaults = await connection.database
      .select({ id: trackedAccounts.id })
      .from(trackedAccounts)
      .where(
        and(
          eq(trackedAccounts.guildId, guildId),
          eq(trackedAccounts.linkedDiscordUserId, 'member-one'),
          eq(trackedAccounts.isDefault, true),
        ),
      );
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.id).toMatch(/^concurrent-default-selection-(one|two)$/);
  });

  it('renames an account within its guild without replacing its stable identity or recap baseline', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const guildId = 'account-rename-guild';

    await repository.register(
      account({
        id: 'rename-account-one',
        guildId,
        displayUsername: 'Rename One',
        normalizedUsername: 'rename one',
      }),
      initialRecapBaseline(),
    );
    await repository.register(
      account({
        id: 'rename-account-two',
        guildId,
        displayUsername: 'Rename Two',
        normalizedUsername: 'rename two',
      }),
      initialRecapBaseline(),
    );

    await expect(
      repository.rename(guildId, 'rename-account-one', {
        displayUsername: 'Renamed Account',
        normalizedUsername: 'renamed account',
      }),
    ).resolves.toMatchObject({
      kind: 'renamed',
      account: { id: 'rename-account-one', displayUsername: 'Renamed Account' },
    });
    await expect(
      repository.rename(guildId, 'rename-account-two', {
        displayUsername: 'Duplicate',
        normalizedUsername: 'renamed account',
      }),
    ).resolves.toEqual({ kind: 'username_taken' });
    await expect(
      repository.rename('different-guild', 'rename-account-one', {
        displayUsername: 'Wrong Guild',
        normalizedUsername: 'wrong guild',
      }),
    ).resolves.toEqual({ kind: 'account_not_found' });
    await expect(
      connection.database
        .select()
        .from(recapBaselines)
        .where(eq(recapBaselines.accountId, 'rename-account-one')),
    ).resolves.toHaveLength(1);
  });

  it('serializes concurrent renames so only one account can claim a normalized username', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const guildId = 'concurrent-account-rename-guild';

    await repository.register(
      account({
        id: 'concurrent-rename-one',
        guildId,
        displayUsername: 'Concurrent Rename One',
        normalizedUsername: 'concurrent rename one',
      }),
      initialRecapBaseline(),
    );
    await repository.register(
      account({
        id: 'concurrent-rename-two',
        guildId,
        displayUsername: 'Concurrent Rename Two',
        normalizedUsername: 'concurrent rename two',
      }),
      initialRecapBaseline(),
    );

    const results = await Promise.all([
      repository.rename(guildId, 'concurrent-rename-one', {
        displayUsername: 'Contested Name',
        normalizedUsername: 'contested name',
      }),
      repository.rename(guildId, 'concurrent-rename-two', {
        displayUsername: 'Contested Name',
        normalizedUsername: 'contested name',
      }),
    ]);

    expect(results.filter((result) => result.kind === 'renamed')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'username_taken')).toHaveLength(1);
  });

  it('changes an account mode within its guild without replacing its identity or recap baseline', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const guildId = 'account-mode-change-guild';

    await repository.register(
      account({
        id: 'mode-change-account',
        guildId,
        displayUsername: 'Mode Change',
        normalizedUsername: 'mode change',
      }),
      initialRecapBaseline(),
    );

    await expect(
      repository.changeMode(guildId, 'mode-change-account', 'ironman'),
    ).resolves.toMatchObject({
      kind: 'mode_changed',
      account: {
        accountMode: 'ironman',
        id: 'mode-change-account',
        isDefault: true,
        quotaOwnerDiscordUserId: 'member-one',
      },
    });
    await expect(
      repository.changeMode('different-guild', 'mode-change-account', 'ultimate_ironman'),
    ).resolves.toEqual({ kind: 'account_not_found' });
    await expect(
      connection.database
        .select()
        .from(recapBaselines)
        .where(eq(recapBaselines.accountId, 'mode-change-account')),
    ).resolves.toHaveLength(1);
  });

  it('converts account associations atomically while preserving baselines and defaults', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const conversion = new AccountAssociationConversionService(repository);
    const guildId = 'account-conversion-guild';

    await repository.register(
      account({
        association: { type: 'watchlist' },
        displayUsername: 'Watchlisted Friend',
        guildId,
        id: 'conversion-watchlist',
        normalizedUsername: 'watchlisted friend',
        quotaOwnerDiscordUserId: 'original-adder',
        registeredByDiscordUserId: 'original-adder',
      }),
      initialRecapBaseline(),
    );
    await repository.register(
      account({
        displayUsername: 'Member Backup',
        guildId,
        id: 'conversion-backup',
        normalizedUsername: 'member backup',
      }),
      initialRecapBaseline(),
    );

    await expect(
      conversion.convert({
        accountId: 'conversion-watchlist',
        canManageAccounts: true,
        guildId,
        requesterDiscordUserId: 'manager-one',
        targetAssociation: { type: 'linked', discordUserId: 'member-one' },
      }),
    ).resolves.toMatchObject({
      kind: 'converted',
      account: {
        association: { type: 'linked', discordUserId: 'member-one' },
        id: 'conversion-watchlist',
        isDefault: false,
        quotaOwnerDiscordUserId: 'member-one',
        registeredByDiscordUserId: 'original-adder',
      },
    });
    await expect(
      conversion.convert({
        accountId: 'conversion-backup',
        canManageAccounts: false,
        guildId,
        requesterDiscordUserId: 'member-one',
        targetAssociation: { type: 'watchlist' },
      }),
    ).resolves.toMatchObject({
      kind: 'converted',
      account: {
        association: { type: 'watchlist' },
        id: 'conversion-backup',
        quotaOwnerDiscordUserId: 'member-one',
      },
    });
    await expect(repository.getDefaultForMember(guildId, 'member-one')).resolves.toMatchObject({
      id: 'conversion-watchlist',
      isDefault: true,
    });
    await expect(
      connection.database
        .select()
        .from(recapBaselines)
        .where(eq(recapBaselines.accountId, 'conversion-watchlist')),
    ).resolves.toHaveLength(1);

    await expect(
      conversion.convert({
        accountId: 'conversion-backup',
        canManageAccounts: true,
        guildId,
        requesterDiscordUserId: 'manager-one',
        targetAssociation: { type: 'linked', discordUserId: 'member-two' },
      }),
    ).resolves.toMatchObject({
      kind: 'converted',
      account: { association: { type: 'linked', discordUserId: 'member-two' } },
    });
    await expect(
      conversion.convert({
        accountId: 'conversion-backup',
        canManageAccounts: false,
        guildId,
        requesterDiscordUserId: 'member-one',
        targetAssociation: { type: 'watchlist' },
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    await expect(repository.getById(guildId, 'conversion-backup')).resolves.toMatchObject({
      association: { type: 'linked', discordUserId: 'member-two' },
    });
  });

  it('rejects association conversion when the destination quota is full', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const conversion = new AccountAssociationConversionService(repository);
    const guildId = 'account-conversion-quota-guild';

    for (let index = 0; index < 10; index += 1) {
      await repository.register(
        account({
          displayUsername: `Full Quota ${index}`,
          guildId,
          id: `full-quota-${index}`,
          normalizedUsername: `full quota ${index}`,
          quotaOwnerDiscordUserId: 'destination-member',
          registeredByDiscordUserId: 'destination-member',
        }),
        initialRecapBaseline(),
      );
    }
    await repository.register(
      account({
        association: { type: 'watchlist' },
        displayUsername: 'Quota Watchlist',
        guildId,
        id: 'quota-watchlist',
        normalizedUsername: 'quota watchlist',
        quotaOwnerDiscordUserId: 'original-adder',
        registeredByDiscordUserId: 'original-adder',
      }),
      initialRecapBaseline(),
    );

    await expect(
      conversion.convert({
        accountId: 'quota-watchlist',
        canManageAccounts: true,
        guildId,
        requesterDiscordUserId: 'manager-one',
        targetAssociation: { type: 'linked', discordUserId: 'destination-member' },
      }),
    ).resolves.toEqual({ kind: 'account_limit_reached' });
    await expect(repository.getById(guildId, 'quota-watchlist')).resolves.toMatchObject({
      association: { type: 'watchlist' },
      quotaOwnerDiscordUserId: 'original-adder',
    });
  });

  it('reassigns a linked account atomically while preserving its baseline and defaults', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const reassignment = new LinkedAccountReassignmentService(repository);
    const guildId = 'linked-account-reassignment-guild';

    await repository.register(
      account({
        displayUsername: 'Source Default',
        guildId,
        id: 'reassignment-source-default',
        normalizedUsername: 'source default',
        quotaOwnerDiscordUserId: 'source-member',
        registeredByDiscordUserId: 'source-member',
        association: { type: 'linked', discordUserId: 'source-member' },
      }),
      initialRecapBaseline(),
    );
    await repository.register(
      account({
        displayUsername: 'Source Backup',
        guildId,
        id: 'reassignment-source-backup',
        normalizedUsername: 'source backup',
        quotaOwnerDiscordUserId: 'source-member',
        registeredByDiscordUserId: 'source-member',
        association: { type: 'linked', discordUserId: 'source-member' },
      }),
      initialRecapBaseline(),
    );

    await expect(
      reassignment.reassign({
        accountId: 'reassignment-source-default',
        canManageAccounts: true,
        guildId,
        requesterDiscordUserId: 'manager-one',
        targetDiscordUserId: 'destination-member',
      }),
    ).resolves.toMatchObject({
      kind: 'reassigned',
      account: {
        association: { type: 'linked', discordUserId: 'destination-member' },
        id: 'reassignment-source-default',
        isDefault: true,
        quotaOwnerDiscordUserId: 'destination-member',
        registeredByDiscordUserId: 'source-member',
      },
    });
    await expect(repository.getDefaultForMember(guildId, 'source-member')).resolves.toMatchObject({
      id: 'reassignment-source-backup',
      isDefault: true,
    });
    await expect(
      connection.database
        .select()
        .from(recapBaselines)
        .where(eq(recapBaselines.accountId, 'reassignment-source-default')),
    ).resolves.toHaveLength(1);
  });

  it('persists member departures and rejoins without changing linked accounts', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const presence = new MemberPresenceService(repository);
    const guildId = 'member-presence-guild';

    await repository.register(
      account({
        displayUsername: 'Presence Player',
        guildId,
        id: 'member-presence-account',
        normalizedUsername: 'presence player',
      }),
      initialRecapBaseline(),
    );

    await expect(presence.markAbsent(guildId, 'member-one')).resolves.toMatchObject({
      discordUserId: 'member-one',
      guildId,
      isPresent: false,
    });
    await expect(presence.get('other-guild', 'member-one')).resolves.toBeUndefined();
    await expect(repository.listLinkedForMember(guildId, 'member-one')).resolves.toMatchObject([
      { id: 'member-presence-account', isDefault: true },
    ]);
    await expect(
      connection.database
        .select()
        .from(recapBaselines)
        .where(eq(recapBaselines.accountId, 'member-presence-account')),
    ).resolves.toHaveLength(1);

    await expect(presence.markPresent(guildId, 'member-one')).resolves.toMatchObject({
      isPresent: true,
    });
    await expect(
      connection.database
        .select()
        .from(guildMemberPresences)
        .where(
          and(
            eq(guildMemberPresences.guildId, guildId),
            eq(guildMemberPresences.discordUserId, 'member-one'),
          ),
        ),
    ).resolves.toMatchObject([{ isPresent: true }]);
  });

  it('preserves the destination default and serializes concurrent destination quota checks', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const reassignment = new LinkedAccountReassignmentService(repository);
    const guildId = 'linked-account-reassignment-quota-guild';

    for (let index = 0; index < 9; index += 1) {
      await repository.register(
        account({
          displayUsername: `Destination ${index}`,
          guildId,
          id: `reassignment-destination-${index}`,
          normalizedUsername: `destination ${index}`,
          quotaOwnerDiscordUserId: 'destination-member',
          registeredByDiscordUserId: 'destination-member',
          association: { type: 'linked', discordUserId: 'destination-member' },
        }),
        initialRecapBaseline(),
      );
    }
    await repository.register(
      account({
        displayUsername: 'Source One',
        guildId,
        id: 'reassignment-source-one',
        normalizedUsername: 'source one',
        quotaOwnerDiscordUserId: 'source-member-one',
        registeredByDiscordUserId: 'source-member-one',
        association: { type: 'linked', discordUserId: 'source-member-one' },
      }),
      initialRecapBaseline(),
    );
    await repository.register(
      account({
        displayUsername: 'Source Two',
        guildId,
        id: 'reassignment-source-two',
        normalizedUsername: 'source two',
        quotaOwnerDiscordUserId: 'source-member-two',
        registeredByDiscordUserId: 'source-member-two',
        association: { type: 'linked', discordUserId: 'source-member-two' },
      }),
      initialRecapBaseline(),
    );

    const results = await Promise.all([
      reassignment.reassign({
        accountId: 'reassignment-source-one',
        canManageAccounts: true,
        guildId,
        requesterDiscordUserId: 'manager-one',
        targetDiscordUserId: 'destination-member',
      }),
      reassignment.reassign({
        accountId: 'reassignment-source-two',
        canManageAccounts: true,
        guildId,
        requesterDiscordUserId: 'manager-one',
        targetDiscordUserId: 'destination-member',
      }),
    ]);

    expect(results.filter((result) => result.kind === 'reassigned')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'account_limit_reached')).toHaveLength(1);
    await expect(
      repository.listLinkedForMember(guildId, 'destination-member'),
    ).resolves.toHaveLength(10);
    await expect(
      repository.getDefaultForMember(guildId, 'destination-member'),
    ).resolves.toMatchObject({
      id: 'reassignment-destination-0',
    });
  });

  it('rolls back the account when initial recap-baseline insertion fails', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const accountId = 'baseline-failure-account';
    const constraintName = 'recap_baselines_forced_failure_check';

    await connection.pool.query(
      `ALTER TABLE recap_baselines ADD CONSTRAINT ${constraintName} CHECK (false) NOT VALID`,
    );
    try {
      await expect(
        repository.register(
          account({
            id: accountId,
            guildId: 'baseline-failure-guild',
            displayUsername: 'Baseline Failure',
            normalizedUsername: 'baseline failure',
          }),
          initialRecapBaseline(),
        ),
      ).rejects.toThrow();
    } finally {
      await connection.pool.query(`ALTER TABLE recap_baselines DROP CONSTRAINT ${constraintName}`);
    }

    const [storedAccount] = await connection.database
      .select({ id: trackedAccounts.id })
      .from(trackedAccounts)
      .where(eq(trackedAccounts.id, accountId));
    const [storedBaseline] = await connection.database
      .select({ accountId: recapBaselines.accountId })
      .from(recapBaselines)
      .where(eq(recapBaselines.accountId, accountId));
    expect(storedAccount).toBeUndefined();
    expect(storedBaseline).toBeUndefined();
  });
});

function initialRecapBaseline() {
  return {
    bossKillCounts: { Zulrah: 12 },
    capturedAt: new Date('2026-07-25T00:00:00.000Z'),
    skillExperience: { Attack: 1234 },
    skillLevels: { Attack: 10 },
  };
}

function account(
  overrides: Partial<{
    association: { type: 'linked'; discordUserId: string } | { type: 'watchlist' };
    displayUsername: string;
    guildId: string;
    id: string;
    normalizedUsername: string;
    quotaOwnerDiscordUserId: string;
    registeredByDiscordUserId: string;
  }>,
) {
  return {
    accountMode: 'main' as const,
    association: { type: 'linked' as const, discordUserId: 'member-one' },
    displayUsername: 'Rune Scape',
    guildId: 'account-guild-one',
    id: 'account-default',
    normalizedUsername: 'rune scape',
    quotaOwnerDiscordUserId: 'member-one',
    registeredByDiscordUserId: 'member-one',
    ...overrides,
  };
}

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
