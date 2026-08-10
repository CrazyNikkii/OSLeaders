import { and, eq, sql } from 'drizzle-orm';

import type {
  CompetitionStartAccount,
  CompetitionStartBeginResult,
  CompetitionStartCompleteResult,
  CompetitionStartRepository,
  CompetitionStartingSnapshot,
} from '../../features/competitions/start-competition.js';
import type { Database, Transaction } from './connection.js';
import {
  competitionAccountSnapshots,
  competitionContributingAccounts,
  competitions,
  trackedAccounts,
} from './schema/index.js';

export class PostgresCompetitionStartRepository implements CompetitionStartRepository {
  public constructor(private readonly database: Database) {}

  public beginStart(request: {
    canManageCompetitions: boolean;
    competitionId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionStartBeginResult> {
    return this.database.transaction(async (transaction) => {
      await lockGuild(transaction, request.guildId);
      const [competition] = await transaction
        .select()
        .from(competitions)
        .where(
          and(
            eq(competitions.guildId, request.guildId),
            eq(competitions.id, request.competitionId),
          ),
        );
      if (competition === undefined) {
        return { kind: 'competition_not_found' };
      }
      if (
        !request.canManageCompetitions &&
        competition.createdByDiscordUserId !== request.requesterDiscordUserId
      ) {
        return { kind: 'forbidden' };
      }
      if (competition.state !== 'draft' && competition.state !== 'start_pending') {
        return { kind: 'start_locked' };
      }

      const accounts = await this.listContributingAccounts(
        transaction,
        request.guildId,
        request.competitionId,
      );
      if (accounts.length === 0) {
        return { kind: 'no_entrants' };
      }
      if (competition.state === 'draft') {
        await transaction
          .update(competitions)
          .set({ state: 'start_pending', updatedAt: new Date() })
          .where(
            and(
              eq(competitions.guildId, request.guildId),
              eq(competitions.id, request.competitionId),
            ),
          );
      }
      return {
        kind: 'ready_to_start',
        competition: {
          accounts,
          competitionId: competition.id,
          durationSeconds: competition.durationSeconds,
          guildId: competition.guildId,
          metric: { kind: competition.metricKind, name: competition.metricName },
        },
      };
    });
  }

  public completeStart(request: {
    competitionId: string;
    guildId: string;
    snapshots: readonly CompetitionStartingSnapshot[];
    startedAt: Date;
  }): Promise<CompetitionStartCompleteResult> {
    return this.database.transaction(async (transaction) => {
      await lockGuild(transaction, request.guildId);
      const [competition] = await transaction
        .select({ durationSeconds: competitions.durationSeconds, state: competitions.state })
        .from(competitions)
        .where(
          and(
            eq(competitions.guildId, request.guildId),
            eq(competitions.id, request.competitionId),
          ),
        );
      if (competition?.state !== 'start_pending') {
        return { kind: 'start_locked' };
      }
      const accounts = await this.listContributingAccounts(
        transaction,
        request.guildId,
        request.competitionId,
      );
      if (!sameAccounts(accounts, request.snapshots)) {
        return { kind: 'start_locked' };
      }
      const endsAt =
        competition.durationSeconds === null
          ? null
          : new Date(request.startedAt.getTime() + competition.durationSeconds * 1_000);
      await transaction.insert(competitionAccountSnapshots).values(
        request.snapshots.map(({ account, value }) => ({
          accountMode: account.accountMode,
          competitionEntrantId: account.competitionEntrantId,
          competitionId: request.competitionId,
          displayUsername: account.displayUsername,
          guildId: request.guildId,
          startingObservedAt: request.startedAt,
          startingValue: value,
          trackedAccountId: account.id,
        })),
      );
      await transaction
        .update(competitions)
        .set({
          endsAt,
          startedAt: request.startedAt,
          state: 'active',
          updatedAt: request.startedAt,
        })
        .where(
          and(
            eq(competitions.guildId, request.guildId),
            eq(competitions.id, request.competitionId),
          ),
        );
      return {
        kind: 'started',
        competitionId: request.competitionId,
        endsAt,
        guildId: request.guildId,
        startedAt: request.startedAt,
      };
    });
  }

  private async listContributingAccounts(
    transaction: Transaction,
    guildId: string,
    competitionId: string,
  ): Promise<CompetitionStartAccount[]> {
    const accounts = await transaction
      .select({
        account: trackedAccounts,
        competitionEntrantId: competitionContributingAccounts.competitionEntrantId,
      })
      .from(competitionContributingAccounts)
      .innerJoin(
        trackedAccounts,
        and(
          eq(trackedAccounts.id, competitionContributingAccounts.trackedAccountId),
          eq(trackedAccounts.guildId, competitionContributingAccounts.guildId),
        ),
      )
      .where(
        and(
          eq(competitionContributingAccounts.guildId, guildId),
          eq(competitionContributingAccounts.competitionId, competitionId),
        ),
      )
      .orderBy(trackedAccounts.createdAt, trackedAccounts.id);
    return accounts.map(({ account, competitionEntrantId }) => ({
      accountMode: account.accountMode,
      association:
        account.associationType === 'linked'
          ? { type: 'linked', discordUserId: required(account.linkedDiscordUserId) }
          : { type: 'watchlist' },
      competitionEntrantId,
      createdAt: account.createdAt,
      displayUsername: account.displayUsername,
      guildId: account.guildId,
      id: account.id,
      isDefault: account.isDefault,
      normalizedUsername: account.normalizedUsername,
      quotaOwnerDiscordUserId: account.quotaOwnerDiscordUserId,
      registeredByDiscordUserId: account.registeredByDiscordUserId,
    }));
  }
}

function sameAccounts(
  accounts: readonly CompetitionStartAccount[],
  snapshots: readonly CompetitionStartingSnapshot[],
): boolean {
  return (
    accounts.length === snapshots.length &&
    accounts.every((account) =>
      snapshots.some(
        (snapshot) =>
          snapshot.account.id === account.id &&
          snapshot.account.competitionEntrantId === account.competitionEntrantId,
      ),
    )
  );
}

function required(value: string | null): string {
  if (value === null) {
    throw new Error('Linked account is missing its Discord user ID.');
  }
  return value;
}

function lockGuild(transaction: Transaction, guildId: string): Promise<unknown> {
  return transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
}
