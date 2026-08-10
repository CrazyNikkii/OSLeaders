import { and, asc, eq, lte, or, sql } from 'drizzle-orm';

import type {
  DueTimedCompetitionFinalization,
  TimedCompetitionFinalizationRepository,
} from '../../features/competitions/finalize-timed-competition.js';
import type { Database, Transaction } from './connection.js';
import {
  competitionAccountFinalValues,
  competitionAccountSnapshots,
  competitionContributingAccounts,
  competitionWinners,
  competitions,
  trackedAccounts,
} from './schema/index.js';

const FINISH_LEASE_MS = 5 * 60 * 1_000;

export class PostgresTimedCompetitionFinalizationRepository implements TimedCompetitionFinalizationRepository {
  public constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async claimDueFinalization(): Promise<DueTimedCompetitionFinalization | undefined> {
    return this.database.transaction(async (transaction) => {
      const now = this.now();
      const [candidate] = await transaction
        .select({ guildId: competitions.guildId })
        .from(competitions)
        .where(dueFinishCondition(now))
        .orderBy(asc(competitions.nextFinishAttemptAt), asc(competitions.endsAt))
        .limit(1);
      if (candidate === undefined) return undefined;
      await lockGuild(transaction, candidate.guildId);
      const [competition] = await transaction
        .select()
        .from(competitions)
        .where(and(eq(competitions.guildId, candidate.guildId), dueFinishCondition(now)))
        .orderBy(asc(competitions.nextFinishAttemptAt), asc(competitions.endsAt))
        .limit(1);
      if (competition?.endsAt === null || competition === undefined) return undefined;
      const accounts = await this.listAccounts(transaction, competition.guildId, competition.id);
      if (accounts.length === 0) return undefined;
      const [claimed] = await transaction
        .update(competitions)
        .set({
          finishAttemptCount: sql`${competitions.finishAttemptCount} + 1`,
          nextFinishAttemptAt: new Date(now.getTime() + FINISH_LEASE_MS),
          state: 'finish_pending',
          updatedAt: now,
        })
        .where(
          and(
            eq(competitions.guildId, competition.guildId),
            eq(competitions.id, competition.id),
            dueFinishCondition(now),
          ),
        )
        .returning({ finishAttemptCount: competitions.finishAttemptCount });
      if (claimed === undefined) return undefined;
      return {
        accounts,
        competitionId: competition.id,
        endsAt: competition.endsAt,
        finishAttemptCount: claimed.finishAttemptCount,
        guildId: competition.guildId,
        metric: { kind: competition.metricKind, name: competition.metricName },
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
          lastFinishFailureSummary: request.failureSummary.slice(0, 500),
          nextFinishAttemptAt: request.nextAttemptAt,
          updatedAt: this.now(),
        })
        .where(
          and(
            eq(competitions.guildId, request.guildId),
            eq(competitions.id, request.competitionId),
            eq(competitions.state, 'finish_pending'),
          ),
        );
    });
  }

  public async completeFinalization(request: {
    competitionId: string;
    finalValues: readonly { accountId: string; entrantId: string; value: bigint }[];
    finalizedAt: Date;
    guildId: string;
    isResultDelayed: boolean;
  }): Promise<
    { kind: 'finished'; winnerEntrantIds: readonly string[] } | { kind: 'finish_locked' }
  > {
    return this.database.transaction(async (transaction) => {
      await lockGuild(transaction, request.guildId);
      const [competition] = await transaction
        .select({ state: competitions.state })
        .from(competitions)
        .where(
          and(
            eq(competitions.guildId, request.guildId),
            eq(competitions.id, request.competitionId),
          ),
        );
      if (competition?.state !== 'finish_pending') return { kind: 'finish_locked' };
      const starts = await transaction
        .select({
          accountId: competitionAccountSnapshots.trackedAccountId,
          entrantId: competitionAccountSnapshots.competitionEntrantId,
          startingValue: competitionAccountSnapshots.startingValue,
        })
        .from(competitionAccountSnapshots)
        .where(
          and(
            eq(competitionAccountSnapshots.guildId, request.guildId),
            eq(competitionAccountSnapshots.competitionId, request.competitionId),
          ),
        );
      if (starts.length !== request.finalValues.length) return { kind: 'finish_locked' };
      const gains = new Map<string, bigint>();
      for (const finalValue of request.finalValues) {
        const start = starts.find((snapshot) => snapshot.accountId === finalValue.accountId);
        if (start?.entrantId !== finalValue.entrantId) return { kind: 'finish_locked' };
        gains.set(
          start.entrantId,
          (gains.get(start.entrantId) ?? 0n) +
            (finalValue.value > start.startingValue ? finalValue.value - start.startingValue : 0n),
        );
      }
      const highest = [...gains.values()].reduce(
        (maximum, gain) => (gain > maximum ? gain : maximum),
        0n,
      );
      const winnerEntrantIds = [...gains]
        .filter(([, gain]) => gain === highest)
        .map(([entrantId]) => entrantId)
        .sort();
      await transaction.insert(competitionAccountFinalValues).values(
        request.finalValues.map((value) => ({
          competitionId: request.competitionId,
          finalObservedAt: request.finalizedAt,
          finalValue: value.value,
          guildId: request.guildId,
          trackedAccountId: value.accountId,
        })),
      );
      await transaction.insert(competitionWinners).values(
        winnerEntrantIds.map((entrantId) => ({
          competitionEntrantId: entrantId,
          competitionId: request.competitionId,
          finalGain: highest,
          guildId: request.guildId,
        })),
      );
      const [finished] = await transaction
        .update(competitions)
        .set({
          finishedAt: request.finalizedAt,
          isResultDelayed: request.isResultDelayed,
          lastFinishFailureSummary: null,
          nextFinishAttemptAt: null,
          state: 'finished',
          updatedAt: request.finalizedAt,
        })
        .where(
          and(
            eq(competitions.guildId, request.guildId),
            eq(competitions.id, request.competitionId),
            eq(competitions.state, 'finish_pending'),
          ),
        )
        .returning({ id: competitions.id });
      return finished === undefined
        ? { kind: 'finish_locked' }
        : { kind: 'finished', winnerEntrantIds };
    });
  }

  private async listAccounts(transaction: Transaction, guildId: string, competitionId: string) {
    const rows = await transaction
      .select({
        account: trackedAccounts,
        competitionEntrantId: competitionContributingAccounts.competitionEntrantId,
        startingValue: competitionAccountSnapshots.startingValue,
      })
      .from(competitionContributingAccounts)
      .innerJoin(
        trackedAccounts,
        and(
          eq(trackedAccounts.id, competitionContributingAccounts.trackedAccountId),
          eq(trackedAccounts.guildId, competitionContributingAccounts.guildId),
        ),
      )
      .innerJoin(
        competitionAccountSnapshots,
        and(
          eq(
            competitionAccountSnapshots.competitionId,
            competitionContributingAccounts.competitionId,
          ),
          eq(
            competitionAccountSnapshots.trackedAccountId,
            competitionContributingAccounts.trackedAccountId,
          ),
          eq(competitionAccountSnapshots.guildId, competitionContributingAccounts.guildId),
        ),
      )
      .where(
        and(
          eq(competitionContributingAccounts.guildId, guildId),
          eq(competitionContributingAccounts.competitionId, competitionId),
        ),
      )
      .orderBy(competitionContributingAccounts.competitionEntrantId, trackedAccounts.id);
    return rows.map(({ account, competitionEntrantId, startingValue }) => ({
      ...account,
      competitionEntrantId,
      startingValue,
    }));
  }
}

function dueFinishCondition(now: Date) {
  return and(
    or(eq(competitions.state, 'active'), eq(competitions.state, 'finish_pending')),
    or(eq(competitions.type, 'most_skill_xp'), eq(competitions.type, 'most_boss_kc')),
    lte(competitions.endsAt, now),
    or(eq(competitions.state, 'active'), lte(competitions.nextFinishAttemptAt, now)),
  );
}

function lockGuild(transaction: Transaction, guildId: string): Promise<unknown> {
  return transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
}
