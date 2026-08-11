import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type {
  CompetitionResultDeliveryRepository,
  PendingCompetitionResultDelivery,
} from '../../features/competitions/deliver-competition-result.js';
import type { Database, Transaction } from './connection.js';
import { competitionResultDeliveries, competitions, guildConfigurations } from './schema/index.js';

const LEASE_MS = 5 * 60 * 1_000;

export class PostgresCompetitionResultDeliveryRepository implements CompetitionResultDeliveryRepository {
  public constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async claimDueDelivery(): Promise<PendingCompetitionResultDelivery | undefined> {
    const now = this.now();
    const [existing] = await this.database
      .select({ guildId: competitionResultDeliveries.guildId })
      .from(competitionResultDeliveries)
      .where(dueCondition(now))
      .orderBy(
        asc(competitionResultDeliveries.nextAttemptAt),
        asc(competitionResultDeliveries.createdAt),
      )
      .limit(1);
    const [finished] =
      existing === undefined
        ? await this.database
            .select({ guildId: competitions.guildId })
            .from(competitions)
            .innerJoin(guildConfigurations, eq(guildConfigurations.guildId, competitions.guildId))
            .leftJoin(
              competitionResultDeliveries,
              and(
                eq(competitionResultDeliveries.guildId, competitions.guildId),
                eq(competitionResultDeliveries.competitionId, competitions.id),
              ),
            )
            .where(
              and(
                inArray(competitions.state, ['finished', 'cancelled']),
                isNull(competitionResultDeliveries.id),
                sql`${guildConfigurations.competitionChannelId} IS NOT NULL`,
              ),
            )
            .orderBy(asc(competitions.finishedAt), asc(competitions.id))
            .limit(1)
        : [];
    const candidate = existing ?? finished;
    if (candidate === undefined) return undefined;
    return this.database.transaction(async (transaction) => {
      await lockGuild(transaction, candidate.guildId);
      return this.claimInTransaction(transaction, candidate.guildId, now);
    });
  }

  public recordSuccess(request: {
    competitionId: string;
    discordMessageId: string;
    guildId: string;
  }): Promise<void> {
    return this.finalize(request.guildId, request.competitionId, 'delivered', {
      deliveredAt: this.now(),
      discordMessageId: request.discordMessageId,
    });
  }
  public recordFailure(request: {
    competitionId: string;
    failureSummary: string;
    guildId: string;
    nextAttemptAt: Date;
  }): Promise<void> {
    return this.finalize(request.guildId, request.competitionId, 'pending', {
      lastFailureSummary: request.failureSummary.slice(0, 500),
      nextAttemptAt: request.nextAttemptAt,
    });
  }

  private async claimInTransaction(
    transaction: Transaction,
    guildId: string,
    now: Date,
  ): Promise<PendingCompetitionResultDelivery | undefined> {
    let [delivery] = await transaction
      .select({
        attemptCount: competitionResultDeliveries.attemptCount,
        channelId: competitionResultDeliveries.channelId,
        competitionId: competitionResultDeliveries.competitionId,
      })
      .from(competitionResultDeliveries)
      .where(and(eq(competitionResultDeliveries.guildId, guildId), dueCondition(now)))
      .orderBy(
        asc(competitionResultDeliveries.nextAttemptAt),
        asc(competitionResultDeliveries.createdAt),
      )
      .limit(1);
    if (delivery === undefined) {
      const [competition] = await transaction
        .select({
          channelId: guildConfigurations.competitionChannelId,
          competitionId: competitions.id,
        })
        .from(competitions)
        .innerJoin(guildConfigurations, eq(guildConfigurations.guildId, competitions.guildId))
        .leftJoin(
          competitionResultDeliveries,
          and(
            eq(competitionResultDeliveries.guildId, competitions.guildId),
            eq(competitionResultDeliveries.competitionId, competitions.id),
          ),
        )
        .where(
          and(
            eq(competitions.guildId, guildId),
            inArray(competitions.state, ['finished', 'cancelled']),
            isNull(competitionResultDeliveries.id),
            sql`${guildConfigurations.competitionChannelId} IS NOT NULL`,
          ),
        )
        .orderBy(asc(competitions.finishedAt), asc(competitions.id))
        .limit(1);
      if (competition?.channelId === null || competition === undefined) return undefined;
      await transaction.insert(competitionResultDeliveries).values({
        id: randomUUID(),
        guildId,
        competitionId: competition.competitionId,
        channelId: competition.channelId,
      });
      delivery = {
        attemptCount: 0,
        channelId: competition.channelId,
        competitionId: competition.competitionId,
      };
    }
    const [claimed] = await transaction
      .update(competitionResultDeliveries)
      .set({
        attemptCount: sql`${competitionResultDeliveries.attemptCount} + 1`,
        status: 'delivering',
        updatedAt: now,
      })
      .where(
        and(
          eq(competitionResultDeliveries.guildId, guildId),
          eq(competitionResultDeliveries.competitionId, delivery.competitionId),
          dueCondition(now),
        ),
      )
      .returning({ competitionId: competitionResultDeliveries.competitionId });
    return claimed === undefined
      ? undefined
      : { ...delivery, attemptCount: delivery.attemptCount + 1, guildId };
  }

  private async finalize(
    guildId: string,
    competitionId: string,
    status: 'delivered' | 'pending',
    values: Partial<typeof competitionResultDeliveries.$inferInsert>,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await lockGuild(transaction, guildId);
      const [updated] = await transaction
        .update(competitionResultDeliveries)
        .set({ ...values, status, updatedAt: this.now() })
        .where(
          and(
            eq(competitionResultDeliveries.guildId, guildId),
            eq(competitionResultDeliveries.competitionId, competitionId),
            eq(competitionResultDeliveries.status, 'delivering'),
          ),
        )
        .returning({ id: competitionResultDeliveries.id });
      if (updated === undefined)
        throw new Error('Competition result delivery is no longer in progress.');
    });
  }
}

function dueCondition(now: Date) {
  return or(
    and(
      inArray(competitionResultDeliveries.status, ['pending', 'failed']),
      or(
        isNull(competitionResultDeliveries.nextAttemptAt),
        lte(competitionResultDeliveries.nextAttemptAt, now),
      ),
    ),
    and(
      eq(competitionResultDeliveries.status, 'delivering'),
      lte(competitionResultDeliveries.updatedAt, new Date(now.getTime() - LEASE_MS)),
    ),
  );
}
async function lockGuild(transaction: Transaction, guildId: string): Promise<void> {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
}
