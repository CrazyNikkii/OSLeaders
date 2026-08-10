import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadTestDatabaseConfiguration } from '../../src/infrastructure/config/database-environment.js';
import { AccountRetrievalService } from '../../src/features/accounts/account-retrieval.js';
import type { CompetitionDraft } from '../../src/features/competitions/create-competition.js';
import { AccountAssociationConversionService } from '../../src/features/accounts/convert-account-association.js';
import { MemberPresenceService } from '../../src/features/accounts/member-presence.js';
import { AccountRemovalService } from '../../src/features/accounts/remove-account.js';
import { LinkedAccountReassignmentService } from '../../src/features/accounts/reassign-linked-account.js';
import { DefaultAccountSelectionService } from '../../src/features/accounts/select-default-account.js';
import {
  createDatabaseConnection,
  type DatabaseConnection,
  withTransaction,
} from '../../src/infrastructure/database/connection.js';
import { PostgresGuildConfigurationRepository } from '../../src/infrastructure/database/postgres-guild-configuration-repository.js';
import { PostgresAccountRegistrationRepository } from '../../src/infrastructure/database/postgres-account-registration-repository.js';
import { PostgresDailyRecapCollectionRepository } from '../../src/infrastructure/database/postgres-daily-recap-collection-repository.js';
import { PostgresManualDailyRecapSendRepository } from '../../src/infrastructure/database/postgres-manual-daily-recap-send-repository.js';
import { PostgresDailyRecapDeliveryRepository } from '../../src/infrastructure/database/postgres-daily-recap-delivery-repository.js';
import { PostgresAutomaticDailyRecapScheduleRepository } from '../../src/infrastructure/database/postgres-automatic-daily-recap-schedule-repository.js';
import { PostgresAutomaticDailyRecapCollectionRepository } from '../../src/infrastructure/database/postgres-automatic-daily-recap-collection-repository.js';
import { PostgresCompetitionCreationRepository } from '../../src/infrastructure/database/postgres-competition-creation-repository.js';
import { PostgresCompetitionDraftParticipationRepository } from '../../src/infrastructure/database/postgres-competition-draft-participation-repository.js';
import { PostgresCompetitionStartRepository } from '../../src/infrastructure/database/postgres-competition-start-repository.js';
import {
  competitionContributingAccounts,
  competitionAccountSnapshots,
  competitionEntrants,
  competitions,
  guildConfigurations,
  guildMemberPresences,
  guilds,
  dailyRecapDeliveries,
  dailyRecapRuns,
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
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('competition_account_snapshots', 'competition_contributing_accounts', 'competition_entrants', 'competitions', 'daily_recap_deliveries', 'daily_recap_runs', 'guild_configurations', 'guild_member_presences', 'guilds', 'recap_baselines', 'tracked_accounts') ORDER BY table_name",
    );
    const migrationTables = await connection.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'",
    );
    const migrationRecords = await connection.pool.query<{ created_at: string; hash: string }>(
      'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at',
    );

    expect(applicationTables.rows).toEqual([
      { table_name: 'competition_account_snapshots' },
      { table_name: 'competition_contributing_accounts' },
      { table_name: 'competition_entrants' },
      { table_name: 'competitions' },
      { table_name: 'daily_recap_deliveries' },
      { table_name: 'daily_recap_runs' },
      { table_name: 'guild_configurations' },
      { table_name: 'guild_member_presences' },
      { table_name: 'guilds' },
      { table_name: 'recap_baselines' },
      { table_name: 'tracked_accounts' },
    ]);
    expect(migrationTables.rows).toEqual([{ table_name: '__drizzle_migrations' }]);
    expect(migrationRecords.rows).toEqual(committedMigrations);
  });

  it('stores draft competitions with guild-scoped normalized-name uniqueness', async () => {
    const repository = new PostgresCompetitionCreationRepository(connection.database);
    const first = competitionDraft({ guildId: 'competition-guild-one', id: 'competition-one' });

    await expect(repository.create(first)).resolves.toMatchObject({ kind: 'created' });
    await expect(
      repository.create({ ...first, id: 'competition-two', displayName: ' WEEKEND  WOODCUTTING ' }),
    ).resolves.toEqual({ kind: 'name_taken' });
    await expect(
      repository.create({ ...first, guildId: 'competition-guild-two', id: 'competition-three' }),
    ).resolves.toMatchObject({ kind: 'created' });

    const rows = await connection.database
      .select()
      .from(competitions)
      .where(eq(competitions.guildId, 'competition-guild-one'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      durationSeconds: 86400,
      metricKind: 'skill',
      metricName: 'Woodcutting',
      state: 'draft',
      targetValue: null,
      type: 'most_skill_xp',
    });
  });

  it('persists draft entrants and contributing accounts with guild and association isolation', async () => {
    const competitionsRepository = new PostgresCompetitionCreationRepository(connection.database);
    const accountsRepository = new PostgresAccountRegistrationRepository(connection.database);
    const repository = new PostgresCompetitionDraftParticipationRepository(connection.database);
    const guildId = 'competition-participation-guild';
    const competitionId = 'competition-participation';
    await competitionsRepository.create(
      competitionDraft({
        guildId,
        id: competitionId,
        displayName: 'Participation competition',
        normalizedName: 'participation competition',
      }),
    );
    await accountsRepository.register(
      account({ id: 'participant-linked-one', guildId }),
      initialRecapBaseline(),
    );
    await accountsRepository.register(
      account({
        id: 'participant-linked-two',
        guildId,
        association: { type: 'linked', discordUserId: 'absent-member' },
        displayUsername: 'Absent Member',
        normalizedUsername: 'absent member',
        quotaOwnerDiscordUserId: 'absent-member',
        registeredByDiscordUserId: 'absent-member',
      }),
      initialRecapBaseline(),
    );
    await accountsRepository.register(
      account({
        id: 'participant-watchlist',
        guildId,
        association: { type: 'watchlist' },
        displayUsername: 'Watchlist Player',
        normalizedUsername: 'watchlist player',
      }),
      initialRecapBaseline(),
    );

    await expect(
      repository.join({
        competitionId,
        contributingAccountIds: ['participant-linked-one'],
        entrantId: 'entrant-one',
        guildId,
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toMatchObject({ kind: 'joined', entrant: { type: 'discord_member' } });
    await expect(
      repository.join({
        competitionId,
        contributingAccountIds: ['participant-linked-one'],
        entrantId: 'duplicate-entrant',
        guildId,
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toEqual({ kind: 'already_joined' });
    await expect(
      repository.join({
        competitionId,
        contributingAccountIds: ['participant-linked-one'],
        entrantId: 'cross-guild-entrant',
        guildId: 'competition-participation-other-guild',
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toEqual({ kind: 'competition_not_found' });
    await expect(
      repository.add({
        canManageCompetitions: false,
        competitionId,
        entrant: {
          type: 'discord_member',
          discordUserId: 'absent-member',
          contributingAccountIds: ['participant-linked-two'],
        },
        entrantId: 'forbidden-entrant',
        guildId,
        requesterDiscordUserId: 'ordinary-member',
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    await expect(
      repository.add({
        canManageCompetitions: false,
        competitionId,
        entrant: {
          type: 'discord_member',
          discordUserId: 'absent-member',
          contributingAccountIds: ['participant-linked-two'],
        },
        entrantId: 'entrant-two',
        guildId,
        requesterDiscordUserId: 'competition-manager-one',
      }),
    ).resolves.toMatchObject({ kind: 'added', entrant: { discordUserId: 'absent-member' } });
    await expect(
      repository.add({
        canManageCompetitions: true,
        competitionId,
        entrant: { type: 'watchlist', watchlistAccountId: 'participant-watchlist' },
        entrantId: 'entrant-watchlist',
        guildId,
        requesterDiscordUserId: 'another-manager',
      }),
    ).resolves.toMatchObject({ kind: 'added', entrant: { type: 'watchlist' } });
    await expect(
      repository.add({
        canManageCompetitions: true,
        competitionId,
        entrant: { type: 'watchlist', watchlistAccountId: 'participant-watchlist' },
        entrantId: 'duplicate-watchlist-entrant',
        guildId,
        requesterDiscordUserId: 'another-manager',
      }),
    ).resolves.toEqual({ kind: 'already_joined' });
    await expect(
      repository.join({
        competitionId,
        contributingAccountIds: ['participant-watchlist'],
        entrantId: 'invalid-entrant',
        guildId,
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toEqual({ kind: 'invalid_accounts' });
    await expect(
      connection.database.transaction(async (transaction) => {
        await transaction.insert(competitionEntrants).values({
          competitionId,
          discordUserId: 'database-duplicate-member',
          entrantType: 'discord_member',
          guildId,
          id: 'database-duplicate-entrant',
          watchlistAccountId: null,
        });
        await transaction.insert(competitionContributingAccounts).values({
          competitionEntrantId: 'database-duplicate-entrant',
          competitionId,
          guildId,
          trackedAccountId: 'participant-linked-one',
        });
      }),
    ).rejects.toThrow();

    await expect(
      connection.database
        .select()
        .from(competitionEntrants)
        .where(eq(competitionEntrants.competitionId, competitionId)),
    ).resolves.toHaveLength(3);
    await expect(
      connection.database
        .select()
        .from(competitionContributingAccounts)
        .where(eq(competitionContributingAccounts.competitionId, competitionId)),
    ).resolves.toHaveLength(3);
    await expect(
      repository.remove({
        canManageCompetitions: true,
        competitionId,
        entrantId: 'entrant-watchlist',
        guildId,
        requesterDiscordUserId: 'another-manager',
      }),
    ).resolves.toMatchObject({ kind: 'removed', entrant: { id: 'entrant-watchlist' } });
    await expect(
      repository.leave({ competitionId, guildId, requesterDiscordUserId: 'member-one' }),
    ).resolves.toMatchObject({ kind: 'left', entrant: { id: 'entrant-one' } });

    await connection.database
      .update(competitions)
      .set({ state: 'active' })
      .where(and(eq(competitions.guildId, guildId), eq(competitions.id, competitionId)));
    await expect(
      repository.remove({
        canManageCompetitions: true,
        competitionId,
        entrantId: 'entrant-two',
        guildId,
        requesterDiscordUserId: 'another-manager',
      }),
    ).resolves.toEqual({ kind: 'membership_locked' });
  });

  it('durably starts a guild-scoped competition with historical starting snapshots and deadline', async () => {
    const competitionsRepository = new PostgresCompetitionCreationRepository(connection.database);
    const accountsRepository = new PostgresAccountRegistrationRepository(connection.database);
    const participationRepository = new PostgresCompetitionDraftParticipationRepository(
      connection.database,
    );
    const repository = new PostgresCompetitionStartRepository(connection.database);
    const guildId = 'competition-start-guild';
    const competitionId = 'competition-start';
    const startedAt = new Date('2026-08-10T12:00:00.000Z');
    await competitionsRepository.create(
      competitionDraft({
        guildId,
        id: competitionId,
        displayName: 'Start competition',
        normalizedName: 'start competition',
      }),
    );
    await accountsRepository.register(
      account({ id: 'competition-start-account', guildId }),
      initialRecapBaseline(),
    );
    await participationRepository.join({
      competitionId,
      contributingAccountIds: ['competition-start-account'],
      entrantId: 'competition-start-entrant',
      guildId,
      requesterDiscordUserId: 'member-one',
    });

    const begin = await repository.beginStart({
      canManageCompetitions: true,
      competitionId,
      guildId,
      requesterDiscordUserId: 'manager-one',
    });
    expect(begin).toMatchObject({
      kind: 'ready_to_start',
      competition: { accounts: [{ id: 'competition-start-account' }], startAttemptCount: 1 },
    });
    if (begin.kind !== 'ready_to_start')
      throw new Error('Expected the competition to be ready to start.');
    await expect(
      repository.completeStart({
        competitionId,
        guildId,
        snapshots: [{ account: begin.competition.accounts[0]!, value: 987654321n }],
        startedAt,
      }),
    ).resolves.toMatchObject({
      kind: 'started',
      endsAt: new Date('2026-08-11T12:00:00.000Z'),
    });
    await expect(
      connection.database
        .select({
          lastStartFailureSummary: competitions.lastStartFailureSummary,
          nextStartAttemptAt: competitions.nextStartAttemptAt,
          startAttemptCount: competitions.startAttemptCount,
        })
        .from(competitions)
        .where(eq(competitions.id, competitionId)),
    ).resolves.toEqual([
      { lastStartFailureSummary: null, nextStartAttemptAt: null, startAttemptCount: 1 },
    ]);
    await expect(
      connection.database
        .select()
        .from(competitionAccountSnapshots)
        .where(eq(competitionAccountSnapshots.competitionId, competitionId)),
    ).resolves.toMatchObject([
      {
        accountMode: 'main',
        displayUsername: 'Rune Scape',
        startingObservedAt: startedAt,
        startingValue: 987654321n,
        trackedAccountId: 'competition-start-account',
      },
    ]);
    await expect(
      repository.beginStart({
        canManageCompetitions: true,
        competitionId,
        guildId,
        requesterDiscordUserId: 'manager-one',
      }),
    ).resolves.toEqual({ kind: 'start_locked' });
    await expect(
      repository.beginStart({
        canManageCompetitions: true,
        competitionId,
        guildId: 'another-guild',
        requesterDiscordUserId: 'manager-one',
      }),
    ).resolves.toEqual({ kind: 'competition_not_found' });
  });

  it('claims only due pending competition starts and persists the next retry state', async () => {
    const creationRepository = new PostgresCompetitionCreationRepository(connection.database);
    const accountsRepository = new PostgresAccountRegistrationRepository(connection.database);
    const participationRepository = new PostgresCompetitionDraftParticipationRepository(
      connection.database,
    );
    const now = new Date('2026-08-10T12:00:00.000Z');
    const repository = new PostgresCompetitionStartRepository(connection.database, () => now);
    const guildId = 'competition-start-retry-guild';
    const competitionId = 'competition-start-retry';
    await creationRepository.create(
      competitionDraft({
        displayName: 'Retry competition',
        guildId,
        id: competitionId,
        normalizedName: 'retry competition',
      }),
    );
    await accountsRepository.register(
      account({ id: 'competition-start-retry-account', guildId }),
      initialRecapBaseline(),
    );
    await participationRepository.join({
      competitionId,
      contributingAccountIds: ['competition-start-retry-account'],
      entrantId: 'competition-start-retry-entrant',
      guildId,
      requesterDiscordUserId: 'member-one',
    });
    await repository.beginStart({
      canManageCompetitions: true,
      competitionId,
      guildId,
      requesterDiscordUserId: 'manager-one',
    });
    await repository.scheduleRetry({
      competitionId,
      failureSummary: 'competition-start-retry-account:timeout',
      guildId,
      nextAttemptAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    await expect(repository.claimDueStart()).resolves.toMatchObject({
      accounts: [{ id: 'competition-start-retry-account' }],
      competitionId,
      guildId,
      startAttemptCount: 2,
    });
    await expect(repository.claimDueStart()).resolves.toBeUndefined();
  });

  it('claims a due scheduled draft once and transitions it to the durable start workflow', async () => {
    const creationRepository = new PostgresCompetitionCreationRepository(connection.database);
    const accountsRepository = new PostgresAccountRegistrationRepository(connection.database);
    const participationRepository = new PostgresCompetitionDraftParticipationRepository(
      connection.database,
    );
    const now = new Date('2026-08-10T12:00:00.000Z');
    const repository = new PostgresCompetitionStartRepository(connection.database, () => now);
    const guildId = 'scheduled-competition-guild';
    const competitionId = 'scheduled-competition';
    await creationRepository.create(
      competitionDraft({
        displayName: 'Scheduled competition',
        guildId,
        id: competitionId,
        intendedStartAt: new Date('2026-08-10T11:59:00.000Z'),
        normalizedName: 'scheduled competition',
      }),
    );
    await accountsRepository.register(
      account({ id: 'scheduled-competition-account', guildId }),
      initialRecapBaseline(),
    );
    await participationRepository.join({
      competitionId,
      contributingAccountIds: ['scheduled-competition-account'],
      entrantId: 'scheduled-competition-entrant',
      guildId,
      requesterDiscordUserId: 'member-one',
    });

    await expect(repository.claimDueStart()).resolves.toMatchObject({
      accounts: [{ id: 'scheduled-competition-account' }],
      competitionId,
      guildId,
      startAttemptCount: 1,
    });
    await expect(repository.claimDueStart()).resolves.toBeUndefined();
    await expect(
      connection.database
        .select({ nextStartAttemptAt: competitions.nextStartAttemptAt, state: competitions.state })
        .from(competitions)
        .where(and(eq(competitions.guildId, guildId), eq(competitions.id, competitionId))),
    ).resolves.toEqual([
      {
        nextStartAttemptAt: new Date('2026-08-10T12:05:00.000Z'),
        state: 'start_pending',
      },
    ]);
  });

  it('does not activate a scheduled draft without entrants', async () => {
    const creationRepository = new PostgresCompetitionCreationRepository(connection.database);
    const now = new Date('2026-08-10T12:00:00.000Z');
    const repository = new PostgresCompetitionStartRepository(connection.database, () => now);
    const guildId = 'scheduled-empty-competition-guild';
    const competitionId = 'scheduled-empty-competition';
    await creationRepository.create(
      competitionDraft({
        displayName: 'Scheduled empty competition',
        guildId,
        id: competitionId,
        intendedStartAt: new Date('2026-08-10T11:59:00.000Z'),
        normalizedName: 'scheduled empty competition',
      }),
    );

    await expect(repository.claimDueStart()).resolves.toBeUndefined();
    await expect(
      connection.database
        .select({ intendedStartAt: competitions.intendedStartAt, state: competitions.state })
        .from(competitions)
        .where(and(eq(competitions.guildId, guildId), eq(competitions.id, competitionId))),
    ).resolves.toEqual([
      {
        intendedStartAt: new Date('2026-08-10T12:05:00.000Z'),
        state: 'draft',
      },
    ]);
  });

  it('recovers an interrupted initial start once its durable lease expires', async () => {
    const creationRepository = new PostgresCompetitionCreationRepository(connection.database);
    const accountsRepository = new PostgresAccountRegistrationRepository(connection.database);
    const participationRepository = new PostgresCompetitionDraftParticipationRepository(
      connection.database,
    );
    let now = new Date('2026-07-10T12:00:00.000Z');
    const repository = new PostgresCompetitionStartRepository(connection.database, () => now);
    const guildId = 'competition-start-interruption-guild';
    const competitionId = 'competition-start-interruption';
    await creationRepository.create(
      competitionDraft({
        displayName: 'Interrupted start',
        guildId,
        id: competitionId,
        normalizedName: 'interrupted start',
      }),
    );
    await accountsRepository.register(
      account({ id: 'competition-start-interruption-account', guildId }),
      initialRecapBaseline(),
    );
    await participationRepository.join({
      competitionId,
      contributingAccountIds: ['competition-start-interruption-account'],
      entrantId: 'competition-start-interruption-entrant',
      guildId,
      requesterDiscordUserId: 'member-one',
    });

    await expect(
      repository.beginStart({
        canManageCompetitions: true,
        competitionId,
        guildId,
        requesterDiscordUserId: 'manager-one',
      }),
    ).resolves.toMatchObject({ kind: 'ready_to_start', competition: { startAttemptCount: 1 } });
    await expect(repository.claimDueStart()).resolves.toBeUndefined();

    now = new Date('2026-07-10T12:05:00.000Z');
    await expect(repository.claimDueStart()).resolves.toMatchObject({
      accounts: [{ id: 'competition-start-interruption-account' }],
      competitionId,
      guildId,
      startAttemptCount: 2,
    });
  });

  it('lists only guild-scoped draft and start-pending competitions for manual start', async () => {
    const creationRepository = new PostgresCompetitionCreationRepository(connection.database);
    const repository = new PostgresCompetitionStartRepository(connection.database);
    const guildId = 'competition-start-choices-guild';
    await creationRepository.create(
      competitionDraft({
        displayName: 'Draft start choice',
        guildId,
        id: 'competition-start-choice-draft',
        normalizedName: 'draft start choice',
      }),
    );
    await creationRepository.create(
      competitionDraft({
        displayName: 'Pending start choice',
        guildId,
        id: 'competition-start-choice-pending',
        normalizedName: 'pending start choice',
      }),
    );
    await creationRepository.create(
      competitionDraft({
        displayName: 'Active start exclusion',
        guildId,
        id: 'competition-start-choice-active',
        normalizedName: 'active start exclusion',
      }),
    );
    await creationRepository.create(
      competitionDraft({
        displayName: 'Other guild draft',
        guildId: 'competition-start-choices-other-guild',
        id: 'competition-start-choice-other-guild',
        normalizedName: 'other guild draft',
      }),
    );
    await connection.database
      .update(competitions)
      .set({ state: 'start_pending' })
      .where(eq(competitions.id, 'competition-start-choice-pending'));
    await connection.database
      .update(competitions)
      .set({ state: 'active' })
      .where(eq(competitions.id, 'competition-start-choice-active'));

    await expect(repository.listStartable(guildId)).resolves.toEqual([
      { displayName: 'Draft start choice', id: 'competition-start-choice-draft' },
      { displayName: 'Pending start choice', id: 'competition-start-choice-pending' },
    ]);
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
      modeEmojis: {},
      recapChannelId: null,
      recapEnabled: false,
      recapLocalTime: null,
      timezone: 'Europe/Helsinki',
    });
    await repository.update('configuration-guild-one', {
      administrativeLogChannelId: 'audit-channel-one',
      administrativeLogMode: 'verbose',
      botManagerRoleId: 'bot-manager-one',
      modeEmojis: { ironman: { id: 'emoji-one', name: 'ironman' } },
      recapChannelId: 'recap-channel-one',
      recapEnabled: true,
      recapLocalTime: '18:00',
      timezone: 'Europe/London',
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
      modeEmojis: { ironman: { id: 'emoji-one', name: 'ironman' } },
      recapChannelId: 'recap-channel-one',
      recapEnabled: true,
      recapLocalTime: '18:00',
      timezone: 'Europe/London',
    });
    await expect(repository.getOrCreate('configuration-guild-two')).resolves.toMatchObject({
      administrativeLogChannelId: null,
      administrativeLogMode: 'standard',
      botManagerRoleId: null,
      competitionManagerRoleId: 'competition-manager-two',
      modeEmojis: {},
      recapChannelId: null,
      recapEnabled: false,
      recapLocalTime: null,
      timezone: 'Europe/Helsinki',
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

  it('loads recap collection accounts with baselines only from the requested guild', async () => {
    const accounts = new PostgresAccountRegistrationRepository(connection.database);
    const recaps = new PostgresDailyRecapCollectionRepository(connection.database);

    await accounts.register(
      account({
        displayUsername: 'Recap Guild One',
        guildId: 'recap-collection-guild-one',
        id: 'recap-collection-one',
        normalizedUsername: 'recap guild one',
      }),
      initialRecapBaseline(),
    );
    await accounts.register(
      account({
        displayUsername: 'Recap Guild Two',
        guildId: 'recap-collection-guild-two',
        id: 'recap-collection-two',
        normalizedUsername: 'recap guild two',
      }),
      initialRecapBaseline(),
    );

    const results = await recaps.listForGuild('recap-collection-guild-one');
    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result?.account.id).toBe('recap-collection-one');
    expect(result?.baseline.bossKillCounts).toEqual({ Zulrah: 12 });
    expect(result?.baseline.skillExperience).toEqual({ Attack: 1234 });
    expect(result?.baseline.skillLevels).toEqual({ Attack: 10 });
  });

  it('durably prepares a manual recap delivery and advances only successful account baselines', async () => {
    const accounts = new PostgresAccountRegistrationRepository(connection.database);
    const repository = new PostgresManualDailyRecapSendRepository(
      connection.database,
      () => new Date('2026-07-31T12:00:00.000Z'),
    );
    const guildId = 'manual-recap-guild';
    const successful = await accounts.register(
      account({
        displayUsername: 'Manual Success',
        guildId,
        id: 'manual-success-account',
        normalizedUsername: 'manual success',
      }),
      initialRecapBaseline(),
    );
    const failed = await accounts.register(
      account({
        displayUsername: 'Manual Failure',
        guildId,
        id: 'manual-failure-account',
        normalizedUsername: 'manual failure',
      }),
      initialRecapBaseline(),
    );
    if (successful.kind !== 'registered' || failed.kind !== 'registered') {
      throw new Error('Manual recap test accounts were not registered.');
    }
    await connection.database.insert(guildConfigurations).values({
      guildId,
      recapChannelId: 'manual-recap-channel',
    });

    await expect(repository.startManualRun(guildId, 'manual-recap-run')).resolves.toEqual({
      kind: 'started',
      run: { recapChannelId: 'manual-recap-channel', recapRunId: 'manual-recap-run' },
    });
    await expect(repository.startManualRun(guildId, 'second-manual-recap-run')).resolves.toEqual({
      kind: 'recap_already_running',
    });
    await repository.finalizeManualRun({
      collection: {
        completedAt: new Date('2026-07-31T11:05:00.000Z'),
        guildId,
        outcomes: [
          {
            account: successful.account,
            candidateBaseline: {
              bossKillCounts: { Zulrah: 20 },
              capturedAt: new Date('2026-07-31T11:00:00.000Z'),
              skillExperience: { Attack: 2000 },
              skillLevels: { Attack: 20 },
            },
            changes: { bosses: [{ boss: 'Zulrah', killCountGained: 8 }], skills: [] },
            kind: 'success',
            previousBaselineCapturedAt: new Date('2026-07-25T00:00:00.000Z'),
          },
          { account: failed.account, failure: { kind: 'timeout' }, kind: 'failure' },
        ],
        startedAt: new Date('2026-07-31T10:00:00.000Z'),
      },
      deliveryContent:
        '# Daily recap\n## <@member-one>\n### Manual Success (Main)\n*Compared with the last successful snapshot: <t:1784937600:f>*\n**Boss activities**\n• Zulrah: +8 KC\n## Unavailable accounts\n**Manual Failure** (Main) — Hiscores timed out',
      guildId,
      recapChannelId: 'manual-recap-channel',
      recapRunId: 'manual-recap-run',
    });

    await expect(
      connection.database
        .select({ accountId: recapBaselines.accountId, experience: recapBaselines.skillExperience })
        .from(recapBaselines)
        .where(eq(recapBaselines.guildId, guildId))
        .orderBy(recapBaselines.accountId),
    ).resolves.toEqual([
      { accountId: 'manual-failure-account', experience: { Attack: 1234 } },
      { accountId: 'manual-success-account', experience: { Attack: 2000 } },
    ]);
    await expect(
      connection.database
        .select({ content: dailyRecapDeliveries.content, status: dailyRecapDeliveries.status })
        .from(dailyRecapDeliveries)
        .where(eq(dailyRecapDeliveries.recapRunId, 'manual-recap-run')),
    ).resolves.toEqual([
      {
        content:
          '# Daily recap\n## <@member-one>\n### Manual Success (Main)\n*Compared with the last successful snapshot: <t:1784937600:f>*\n**Boss activities**\n• Zulrah: +8 KC\n## Unavailable accounts\n**Manual Failure** (Main) — Hiscores timed out',
        status: 'pending',
      },
    ]);
    await expect(
      connection.database
        .select({ status: dailyRecapRuns.status })
        .from(dailyRecapRuns)
        .where(eq(dailyRecapRuns.id, 'manual-recap-run')),
    ).resolves.toEqual([{ status: 'delivery_pending' }]);
  });

  it('claims, delivers, fails, and isolates durable recap deliveries by guild', async () => {
    let now = new Date('2026-07-31T12:00:00.000Z');
    const repository = new PostgresDailyRecapDeliveryRepository(connection.database, () => now);
    const guildId = 'delivery-guild-one';
    const otherGuildId = 'delivery-guild-two';
    await connection.database.insert(guilds).values([{ guildId }, { guildId: otherGuildId }]);
    await connection.database.insert(dailyRecapRuns).values([
      { guildId, id: 'delivery-run-one', status: 'delivery_pending', trigger: 'manual' },
      { guildId, id: 'delivery-run-two', status: 'delivery_pending', trigger: 'manual' },
      { guildId, id: 'delivery-run-three', status: 'delivery_pending', trigger: 'manual' },
    ]);
    await connection.database.insert(dailyRecapDeliveries).values([
      {
        channelId: 'delivery-channel-one',
        content: '# Daily recap one',
        guildId,
        id: 'delivery-one',
        recapRunId: 'delivery-run-one',
      },
      {
        channelId: 'delivery-channel-two',
        content: '# Daily recap two',
        guildId,
        id: 'delivery-two',
        recapRunId: 'delivery-run-two',
      },
      {
        channelId: 'delivery-channel-three',
        content: '# Daily recap three',
        guildId,
        id: 'delivery-three',
        recapRunId: 'delivery-run-three',
        status: 'delivering',
        updatedAt: now,
      },
    ]);

    await expect(
      repository.claimPendingDelivery(otherGuildId, 'delivery-run-one'),
    ).resolves.toBeUndefined();
    await expect(repository.claimPendingDelivery(guildId, 'delivery-run-one')).resolves.toEqual({
      attemptCount: 1,
      channelId: 'delivery-channel-one',
      content: '# Daily recap one',
      guildId,
      recapRunId: 'delivery-run-one',
    });
    await expect(
      repository.claimPendingDelivery(guildId, 'delivery-run-one'),
    ).resolves.toBeUndefined();
    await repository.recordDeliverySuccess(guildId, 'delivery-run-one', 'discord-message-one');
    await expect(
      connection.database
        .select({
          deliveredAt: dailyRecapDeliveries.deliveredAt,
          discordMessageId: dailyRecapDeliveries.discordMessageId,
          status: dailyRecapDeliveries.status,
        })
        .from(dailyRecapDeliveries)
        .where(eq(dailyRecapDeliveries.recapRunId, 'delivery-run-one')),
    ).resolves.toEqual([
      { deliveredAt: now, discordMessageId: 'discord-message-one', status: 'delivered' },
    ]);
    await expect(
      connection.database
        .select({ status: dailyRecapRuns.status })
        .from(dailyRecapRuns)
        .where(eq(dailyRecapRuns.id, 'delivery-run-one')),
    ).resolves.toEqual([{ status: 'delivered' }]);
    await expect(
      repository.claimPendingDelivery(guildId, 'delivery-run-two'),
    ).resolves.toMatchObject({
      recapRunId: 'delivery-run-two',
    });
    await repository.recordDeliveryFailure(
      guildId,
      'delivery-run-two',
      'Discord rejected delivery.',
      new Date(now.getTime() + 60_000),
    );
    await expect(
      connection.database
        .select({
          lastFailureSummary: dailyRecapDeliveries.lastFailureSummary,
          nextAttemptAt: dailyRecapDeliveries.nextAttemptAt,
          status: dailyRecapDeliveries.status,
        })
        .from(dailyRecapDeliveries)
        .where(eq(dailyRecapDeliveries.recapRunId, 'delivery-run-two')),
    ).resolves.toEqual([
      {
        lastFailureSummary: 'Discord rejected delivery.',
        nextAttemptAt: new Date(now.getTime() + 60_000),
        status: 'pending',
      },
    ]);
    await connection.database
      .update(dailyRecapDeliveries)
      .set({ nextAttemptAt: new Date(now.getTime() + 24 * 60 * 60_000) })
      .where(eq(dailyRecapDeliveries.guildId, 'manual-recap-guild'));
    await expect(repository.claimDueRecoverableDelivery()).resolves.toBeUndefined();
    now = new Date(now.getTime() + 60_000);
    await expect(repository.claimDueRecoverableDelivery()).resolves.toMatchObject({
      attemptCount: 2,
      recapRunId: 'delivery-run-two',
    });
    await repository.recordDeliverySuccess(guildId, 'delivery-run-two', 'discord-message-two');
    await expect(
      connection.database
        .select({ status: dailyRecapRuns.status })
        .from(dailyRecapRuns)
        .where(eq(dailyRecapRuns.id, 'delivery-run-two')),
    ).resolves.toEqual([{ status: 'delivered' }]);
    await expect(repository.claimRecoverableDelivery(guildId)).resolves.toBeUndefined();
    await connection.database
      .update(dailyRecapDeliveries)
      .set({ updatedAt: new Date(now.getTime() - 5 * 60 * 1_000) })
      .where(eq(dailyRecapDeliveries.recapRunId, 'delivery-run-three'));
    await expect(repository.claimRecoverableDelivery(guildId)).resolves.toMatchObject({
      attemptCount: 1,
      recapRunId: 'delivery-run-three',
    });
  });

  it('keeps durable recap runs and deliveries in their owning guild', async () => {
    await connection.database
      .insert(guilds)
      .values([{ guildId: 'recap-run-guild-one' }, { guildId: 'recap-run-guild-two' }]);
    await connection.database.insert(dailyRecapRuns).values({
      collectionAttemptCount: 2,
      lastCollectionFailureSummary: 'Hiscores request timed out.',
      nextCollectionAttemptAt: new Date('2026-07-31T15:05:00.000Z'),
      guildId: 'recap-run-guild-one',
      id: 'automatic-recap-run',
      scheduledFor: new Date('2026-07-31T15:00:00.000Z'),
      trigger: 'automatic',
    });
    await connection.database.insert(dailyRecapDeliveries).values({
      channelId: 'recap-channel-one',
      content: 'A durable daily recap.',
      guildId: 'recap-run-guild-one',
      id: 'recap-delivery-one',
      recapRunId: 'automatic-recap-run',
    });

    await expect(
      connection.database.insert(dailyRecapDeliveries).values({
        channelId: 'recap-channel-two',
        content: 'Cross-guild delivery must fail.',
        guildId: 'recap-run-guild-two',
        id: 'cross-guild-recap-delivery',
        recapRunId: 'automatic-recap-run',
      }),
    ).rejects.toThrow();
    await expect(
      connection.database.insert(dailyRecapDeliveries).values({
        channelId: 'recap-channel-one',
        content: 'A duplicate durable recap.',
        guildId: 'recap-run-guild-one',
        id: 'duplicate-recap-delivery',
        recapRunId: 'automatic-recap-run',
      }),
    ).rejects.toThrow();
    await expect(
      connection.database.insert(dailyRecapRuns).values({
        guildId: 'recap-run-guild-two',
        id: 'unscheduled-automatic-recap-run',
        trigger: 'automatic',
      }),
    ).rejects.toThrow();
    await expect(
      connection.database.insert(dailyRecapRuns).values({
        guildId: 'recap-run-guild-one',
        id: 'duplicate-automatic-recap-run',
        scheduledFor: new Date('2026-07-31T15:00:00.000Z'),
        trigger: 'automatic',
      }),
    ).rejects.toThrow();
    await expect(
      connection.database.insert(dailyRecapRuns).values({
        guildId: 'recap-run-guild-one',
        id: 'manual-recap-run-at-same-time',
        scheduledFor: new Date('2026-07-31T15:00:00.000Z'),
        trigger: 'manual',
      }),
    ).resolves.toBeDefined();

    await expect(
      connection.database
        .select()
        .from(dailyRecapRuns)
        .where(eq(dailyRecapRuns.id, 'automatic-recap-run')),
    ).resolves.toMatchObject([
      {
        collectionAttemptCount: 2,
        lastCollectionFailureSummary: 'Hiscores request timed out.',
        nextCollectionAttemptAt: new Date('2026-07-31T15:05:00.000Z'),
      },
    ]);
    await expect(
      connection.database
        .select()
        .from(dailyRecapDeliveries)
        .where(eq(dailyRecapDeliveries.guildId, 'recap-run-guild-two')),
    ).resolves.toEqual([]);
  });

  it('lists only enabled complete recap configurations and creates one automatic run per guild instant', async () => {
    const configurations = new PostgresGuildConfigurationRepository(connection.database);
    const repository = new PostgresAutomaticDailyRecapScheduleRepository(connection.database);
    const scheduledFor = new Date('2026-08-01T15:00:00.000Z');

    await configurations.update('automatic-schedule-guild-one', {
      recapChannelId: 'recap-channel-one',
      recapEnabled: true,
      recapLocalTime: '18:00',
      timezone: 'Europe/Helsinki',
    });
    await configurations.update('automatic-schedule-guild-two', {
      recapEnabled: true,
      recapLocalTime: '18:00',
    });

    const enabled = await repository.listEnabledRecapConfigurations();
    expect(enabled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          guildId: 'automatic-schedule-guild-one',
          recapChannelId: 'recap-channel-one',
          recapEnabled: true,
          recapLocalTime: '18:00',
        }),
      ]),
    );
    expect(enabled.map((configuration) => configuration.guildId)).not.toContain(
      'automatic-schedule-guild-two',
    );
    await expect(
      repository.createAutomaticRun(
        'automatic-schedule-guild-one',
        'automatic-schedule-run-one',
        scheduledFor,
      ),
    ).resolves.toBe(true);
    await expect(
      repository.createAutomaticRun(
        'automatic-schedule-guild-one',
        'automatic-schedule-run-two',
        scheduledFor,
      ),
    ).resolves.toBe(false);
    await expect(
      repository.createAutomaticRun(
        'automatic-schedule-guild-two',
        'automatic-schedule-run-three',
        scheduledFor,
      ),
    ).resolves.toBe(true);
  });

  it('claims, finalizes, and durably queues a due automatic recap in its guild', async () => {
    const accounts = new PostgresAccountRegistrationRepository(connection.database);
    const configurations = new PostgresGuildConfigurationRepository(connection.database);
    const now = new Date('2026-08-05T12:00:00.000Z');
    const repository = new PostgresAutomaticDailyRecapCollectionRepository(
      connection.database,
      () => now,
    );
    const guildId = 'automatic-collection-guild';
    const registered = await accounts.register(
      account({
        displayUsername: 'Automatic Collection',
        guildId,
        id: 'automatic-collection-account',
        normalizedUsername: 'automatic collection',
      }),
      initialRecapBaseline(),
    );
    if (registered.kind !== 'registered') {
      throw new Error('Automatic collection test account was not registered.');
    }
    await configurations.update(guildId, {
      recapChannelId: 'automatic-recap-channel',
      recapEnabled: true,
      recapLocalTime: '18:00',
      timezone: 'Europe/Helsinki',
    });
    await connection.database.insert(dailyRecapRuns).values({
      guildId,
      id: 'automatic-collection-run',
      scheduledFor: new Date('2026-07-01T11:00:00.000Z'),
      trigger: 'automatic',
    });

    await expect(repository.claimDueRun()).resolves.toEqual({
      collectionAttemptCount: 1,
      guildId,
      recapChannelId: 'automatic-recap-channel',
      recapRunId: 'automatic-collection-run',
    });
    await repository.finalizeRun({
      collection: {
        completedAt: new Date('2026-08-05T12:01:00.000Z'),
        guildId,
        outcomes: [
          {
            account: registered.account,
            candidateBaseline: {
              ...initialRecapBaseline(),
              capturedAt: new Date('2026-08-05T12:00:00.000Z'),
              skillExperience: { Attack: 9999 },
            },
            changes: { bosses: [], skills: [] },
            kind: 'success',
            previousBaselineCapturedAt: new Date('2026-07-25T00:00:00.000Z'),
          },
        ],
        startedAt: new Date('2026-08-05T12:00:00.000Z'),
      },
      deliveryContent: 'Automatic daily recap.',
      guildId,
      recapChannelId: 'automatic-recap-channel',
      recapRunId: 'automatic-collection-run',
    });
    await expect(
      connection.database
        .select({
          comparisonStartedAt: dailyRecapRuns.comparisonStartedAt,
          status: dailyRecapRuns.status,
        })
        .from(dailyRecapRuns)
        .where(eq(dailyRecapRuns.id, 'automatic-collection-run')),
    ).resolves.toEqual([
      { comparisonStartedAt: new Date('2026-08-05T12:00:00.000Z'), status: 'delivery_pending' },
    ]);
    await expect(
      connection.database
        .select({
          channelId: dailyRecapDeliveries.channelId,
          content: dailyRecapDeliveries.content,
        })
        .from(dailyRecapDeliveries)
        .where(eq(dailyRecapDeliveries.recapRunId, 'automatic-collection-run')),
    ).resolves.toEqual([
      { channelId: 'automatic-recap-channel', content: 'Automatic daily recap.' },
    ]);
    await expect(
      connection.database
        .select({
          capturedAt: recapBaselines.capturedAt,
          skillExperience: recapBaselines.skillExperience,
        })
        .from(recapBaselines)
        .where(eq(recapBaselines.accountId, 'automatic-collection-account')),
    ).resolves.toEqual([
      {
        capturedAt: new Date('2026-08-05T12:00:00.000Z'),
        skillExperience: { Attack: 9999 },
      },
    ]);
  });

  it('fails a due automatic recap when its configuration is disabled before collection', async () => {
    const now = new Date('2026-01-02T12:00:00.000Z');
    const repository = new PostgresAutomaticDailyRecapCollectionRepository(
      connection.database,
      () => now,
    );
    const guildId = 'automatic-collection-disabled-guild';
    const configurations = new PostgresGuildConfigurationRepository(connection.database);
    await configurations.update(guildId, {
      recapChannelId: 'disabled-recap-channel',
      recapEnabled: false,
      recapLocalTime: '18:00',
      timezone: 'Europe/Helsinki',
    });
    await connection.database.insert(dailyRecapRuns).values({
      guildId,
      id: 'automatic-collection-disabled-run',
      scheduledFor: new Date('2026-01-01T11:00:00.000Z'),
      trigger: 'automatic',
    });
    await configurations.update('automatic-collection-future-guild', {
      recapChannelId: 'future-recap-channel',
      recapEnabled: true,
      recapLocalTime: '18:00',
      timezone: 'Europe/Helsinki',
    });
    await connection.database.insert(dailyRecapRuns).values({
      guildId: 'automatic-collection-future-guild',
      id: 'automatic-collection-future-run',
      scheduledFor: new Date('2026-01-03T11:00:00.000Z'),
      trigger: 'automatic',
    });

    await expect(repository.claimDueRun()).resolves.toBeUndefined();
    await expect(
      connection.database
        .select({
          failure: dailyRecapRuns.lastCollectionFailureSummary,
          status: dailyRecapRuns.status,
        })
        .from(dailyRecapRuns)
        .where(eq(dailyRecapRuns.id, 'automatic-collection-disabled-run')),
    ).resolves.toEqual([
      {
        failure: 'Automatic daily recap is no longer configured.',
        status: 'failed',
      },
    ]);
    await expect(
      connection.database
        .select({ status: dailyRecapRuns.status })
        .from(dailyRecapRuns)
        .where(eq(dailyRecapRuns.id, 'automatic-collection-future-run')),
    ).resolves.toEqual([{ status: 'pending_collection' }]);
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

  it('removes accounts within their guild, cascades baselines, and repairs defaults', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const removal = new AccountRemovalService(repository);
    const guildId = 'account-removal-guild';

    await repository.register(
      account({
        displayUsername: 'Removal Default',
        guildId,
        id: 'removal-default',
        normalizedUsername: 'removal default',
      }),
      initialRecapBaseline(),
    );
    await repository.register(
      account({
        displayUsername: 'Removal Oldest Replacement',
        guildId,
        id: 'removal-oldest-replacement',
        normalizedUsername: 'removal oldest replacement',
      }),
      initialRecapBaseline(),
    );
    await repository.register(
      account({
        displayUsername: 'Removal Newer Replacement',
        guildId,
        id: 'removal-newer-replacement',
        normalizedUsername: 'removal newer replacement',
      }),
      initialRecapBaseline(),
    );

    await expect(
      removal.remove({
        accountId: 'removal-default',
        canManageAccounts: false,
        guildId,
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toMatchObject({
      kind: 'removed',
      account: { id: 'removal-default' },
      replacementDefaultAccount: { id: 'removal-oldest-replacement', isDefault: true },
    });
    await expect(repository.getById(guildId, 'removal-default')).resolves.toBeUndefined();
    await expect(repository.getDefaultForMember(guildId, 'member-one')).resolves.toMatchObject({
      id: 'removal-oldest-replacement',
      isDefault: true,
    });
    await expect(
      connection.database
        .select()
        .from(recapBaselines)
        .where(eq(recapBaselines.accountId, 'removal-default')),
    ).resolves.toEqual([]);
  });

  it('does not remove accounts from another guild or allow an unauthorized requester', async () => {
    const repository = new PostgresAccountRegistrationRepository(connection.database);
    const removal = new AccountRemovalService(repository);

    await repository.register(
      account({
        displayUsername: 'Removal Protected',
        guildId: 'account-removal-protected-guild',
        id: 'removal-protected',
        normalizedUsername: 'removal protected',
      }),
      initialRecapBaseline(),
    );

    await expect(
      removal.remove({
        accountId: 'removal-protected',
        canManageAccounts: true,
        guildId: 'another-guild',
        requesterDiscordUserId: 'manager-one',
      }),
    ).resolves.toEqual({ kind: 'account_not_found' });
    await expect(
      removal.remove({
        accountId: 'removal-protected',
        canManageAccounts: false,
        guildId: 'account-removal-protected-guild',
        requesterDiscordUserId: 'member-two',
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    await expect(
      repository.getById('account-removal-protected-guild', 'removal-protected'),
    ).resolves.toMatchObject({ id: 'removal-protected' });
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

function competitionDraft(overrides: Partial<CompetitionDraft> = {}): CompetitionDraft {
  const timestamp = new Date('2026-08-07T12:00:00.000Z');
  return {
    createdAt: timestamp,
    createdByDiscordUserId: 'competition-manager-one',
    displayName: 'Weekend Woodcutting',
    durationSeconds: 86400,
    guildId: 'competition-guild-one',
    id: 'competition-default',
    metric: { kind: 'skill', name: 'Woodcutting' },
    normalizedName: 'weekend woodcutting',
    state: 'draft',
    targetValue: null,
    timezone: 'Europe/Helsinki',
    type: 'most_skill_xp',
    updatedAt: timestamp,
    ...overrides,
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
