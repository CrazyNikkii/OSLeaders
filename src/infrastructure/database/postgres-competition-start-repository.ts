import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type {
  CompetitionStartAccount,
  CompetitionStartBeginResult,
  CompetitionStartCompleteResult,
  CompetitionStartRepository,
  CompetitionReadyToStart,
  CompetitionStartingSnapshot,
} from '../../features/competitions/start-competition.js';
import type { Database, Transaction } from './connection.js';
import {
  competitionAccountSnapshots,
  competitionContributingAccounts,
  competitions,
  trackedAccounts,
} from './schema/index.js';

const START_LEASE_MS = 5 * 60 * 1_000;

export class PostgresCompetitionStartRepository implements CompetitionStartRepository {
  public constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async listStartable(
    guildId: string,
  ): Promise<readonly { id: string; displayName: string }[]> {
    return this.database
      .select({ displayName: competitions.displayName, id: competitions.id })
      .from(competitions)
      .where(
        and(
          eq(competitions.guildId, guildId),
          inArray(competitions.state, ['draft', 'start_pending']),
        ),
      )
      .orderBy(competitions.createdAt, competitions.id);
  }

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
      const now = this.now();
      const [started] = await transaction
        .update(competitions)
        .set({
          nextStartAttemptAt: new Date(now.getTime() + START_LEASE_MS),
          startAttemptCount: sql`${competitions.startAttemptCount} + 1`,
          state: 'start_pending',
          updatedAt: now,
        })
        .where(
          and(
            eq(competitions.guildId, request.guildId),
            eq(competitions.id, request.competitionId),
            inArray(competitions.state, ['draft', 'start_pending']),
          ),
        )
        .returning({ startAttemptCount: competitions.startAttemptCount });
      if (started === undefined) {
        return { kind: 'start_locked' };
      }
      return {
        kind: 'ready_to_start',
        competition: {
          accounts,
          competitionId: competition.id,
          durationSeconds: competition.durationSeconds,
          guildId: competition.guildId,
          metric: { kind: competition.metricKind, name: competition.metricName },
          startAttemptCount: started.startAttemptCount,
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
          lastStartFailureSummary: null,
          nextStartAttemptAt: null,
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

  public async scheduleRetry(request: {
    competitionId: string;
    failureSummary: string;
    guildId: string;
    nextAttemptAt: Date;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await lockGuild(transaction, request.guildId);
      await transaction
        .update(competitions)
        .set({
          lastStartFailureSummary: request.failureSummary.slice(0, 500),
          nextStartAttemptAt: request.nextAttemptAt,
          updatedAt: this.now(),
        })
        .where(
          and(
            eq(competitions.guildId, request.guildId),
            eq(competitions.id, request.competitionId),
            eq(competitions.state, 'start_pending'),
          ),
        );
    });
  }

  public async claimDueStart(): Promise<CompetitionReadyToStart | undefined> {
    return this.database.transaction(async (transaction) => {
      const now = this.now();
      while (true) {
        const [candidate] = await transaction
          .select({ guildId: competitions.guildId })
          .from(competitions)
          .where(dueStartCondition(now))
          .orderBy(asc(competitions.nextStartAttemptAt), asc(competitions.createdAt))
          .limit(1);
        if (candidate === undefined) {
          return undefined;
        }
        await lockGuild(transaction, candidate.guildId);
        const [competition] = await transaction
          .select()
          .from(competitions)
          .where(and(eq(competitions.guildId, candidate.guildId), dueStartCondition(now)))
          .orderBy(asc(competitions.nextStartAttemptAt), asc(competitions.createdAt))
          .limit(1);
        if (competition === undefined) {
          continue;
        }
        const accounts = await this.listContributingAccounts(
          transaction,
          competition.guildId,
          competition.id,
        );
        if (accounts.length === 0) {
          const nextAttemptAt = new Date(now.getTime() + START_LEASE_MS);
          await transaction
            .update(competitions)
            .set(
              competition.state === 'draft'
                ? { intendedStartAt: nextAttemptAt, updatedAt: now }
                : { nextStartAttemptAt: nextAttemptAt, updatedAt: now },
            )
            .where(
              and(
                eq(competitions.guildId, competition.guildId),
                eq(competitions.id, competition.id),
                dueStartCondition(now),
              ),
            );
          continue;
        }
        const [claimed] = await transaction
          .update(competitions)
          .set({
            nextStartAttemptAt: new Date(now.getTime() + START_LEASE_MS),
            startAttemptCount: sql`${competitions.startAttemptCount} + 1`,
            state: 'start_pending',
            updatedAt: now,
          })
          .where(
            and(
              eq(competitions.guildId, competition.guildId),
              eq(competitions.id, competition.id),
              dueStartCondition(now),
            ),
          )
          .returning({ startAttemptCount: competitions.startAttemptCount });
        if (claimed === undefined) {
          continue;
        }
        return {
          accounts,
          competitionId: competition.id,
          durationSeconds: competition.durationSeconds,
          guildId: competition.guildId,
          metric: { kind: competition.metricKind, name: competition.metricName },
          startAttemptCount: claimed.startAttemptCount,
        };
      }
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

function dueStartCondition(now: Date) {
  return sql`(
    (${competitions.state} = 'start_pending' AND ${competitions.nextStartAttemptAt} <= ${now})
    OR
    (${competitions.state} = 'draft' AND ${competitions.intendedStartAt} <= ${now})
  )`;
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
