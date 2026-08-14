import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type {
  CompetitionStartDeliveryRepository,
  PendingCompetitionStartDelivery,
} from '../../features/competitions/deliver-competition-start-announcement.js';
import type { Database, Transaction } from './connection.js';
import { competitionStartDeliveries, competitions, guildConfigurations } from './schema/index.js';

const LEASE_MS = 5 * 60 * 1_000;

export class PostgresCompetitionStartDeliveryRepository implements CompetitionStartDeliveryRepository {
  public constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async claimDelivery(request: {
    competitionId: string;
    guildId: string;
  }): Promise<PendingCompetitionStartDelivery | undefined> {
    return this.database.transaction(async (transaction) => {
      await lockGuild(transaction, request.guildId);
      return this.claimInTransaction(
        transaction,
        request.guildId,
        this.now(),
        request.competitionId,
      );
    });
  }

  public async claimDueDelivery(): Promise<PendingCompetitionStartDelivery | undefined> {
    const now = this.now();
    const [candidate] = await this.database
      .select({ guildId: competitionStartDeliveries.guildId })
      .from(competitionStartDeliveries)
      .where(dueCondition(now))
      .orderBy(
        asc(competitionStartDeliveries.nextAttemptAt),
        asc(competitionStartDeliveries.createdAt),
      )
      .limit(1);
    const [undelivered] =
      candidate === undefined
        ? await this.database
            .select({ guildId: competitions.guildId })
            .from(competitions)
            .innerJoin(guildConfigurations, eq(guildConfigurations.guildId, competitions.guildId))
            .leftJoin(
              competitionStartDeliveries,
              and(
                eq(competitionStartDeliveries.guildId, competitions.guildId),
                eq(competitionStartDeliveries.competitionId, competitions.id),
              ),
            )
            .where(
              and(
                eq(competitions.state, 'active'),
                isNull(competitionStartDeliveries.id),
                sql`${guildConfigurations.competitionChannelId} IS NOT NULL`,
              ),
            )
            .orderBy(asc(competitions.startedAt), asc(competitions.id))
            .limit(1)
        : [];
    const guildId = candidate?.guildId ?? undelivered?.guildId;
    if (guildId === undefined) return undefined;
    return this.database.transaction(async (transaction) => {
      await lockGuild(transaction, guildId);
      return this.claimInTransaction(transaction, guildId, now);
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
    competitionId?: string,
  ): Promise<PendingCompetitionStartDelivery | undefined> {
    const [existingDelivery] = await transaction
      .select({
        attemptCount: competitionStartDeliveries.attemptCount,
        channelId: competitionStartDeliveries.channelId,
        competitionId: competitionStartDeliveries.competitionId,
        displayName: competitions.displayName,
        endsAt: competitions.endsAt,
        metricKind: competitions.metricKind,
        metricName: competitions.metricName,
        startedAt: competitions.startedAt,
      })
      .from(competitionStartDeliveries)
      .innerJoin(
        competitions,
        and(
          eq(competitions.id, competitionStartDeliveries.competitionId),
          eq(competitions.guildId, competitionStartDeliveries.guildId),
        ),
      )
      .where(
        and(
          eq(competitionStartDeliveries.guildId, guildId),
          competitionId === undefined
            ? dueCondition(now)
            : and(eq(competitionStartDeliveries.competitionId, competitionId), dueCondition(now)),
        ),
      )
      .orderBy(
        asc(competitionStartDeliveries.nextAttemptAt),
        asc(competitionStartDeliveries.createdAt),
      )
      .limit(1);
    let delivery:
      | {
          attemptCount: number;
          channelId: string | null;
          competitionId: string;
          displayName: string;
          endsAt: Date | null;
          metricKind: 'boss' | 'skill';
          metricName: string;
          startedAt: Date | null;
        }
      | undefined = existingDelivery;
    if (delivery === undefined) {
      const [competition] = await transaction
        .select({
          channelId: guildConfigurations.competitionChannelId,
          competitionId: competitions.id,
          displayName: competitions.displayName,
          endsAt: competitions.endsAt,
          metricKind: competitions.metricKind,
          metricName: competitions.metricName,
          startedAt: competitions.startedAt,
        })
        .from(competitions)
        .innerJoin(guildConfigurations, eq(guildConfigurations.guildId, competitions.guildId))
        .leftJoin(
          competitionStartDeliveries,
          and(
            eq(competitionStartDeliveries.guildId, competitions.guildId),
            eq(competitionStartDeliveries.competitionId, competitions.id),
          ),
        )
        .where(
          and(
            eq(competitions.guildId, guildId),
            eq(competitions.state, 'active'),
            competitionId === undefined ? undefined : eq(competitions.id, competitionId),
            isNull(competitionStartDeliveries.id),
            sql`${guildConfigurations.competitionChannelId} IS NOT NULL`,
          ),
        )
        .orderBy(asc(competitions.startedAt), asc(competitions.id))
        .limit(1);
      if (competition?.channelId == null || competition.startedAt == null) return undefined;
      await transaction.insert(competitionStartDeliveries).values({
        channelId: competition.channelId,
        competitionId: competition.competitionId,
        guildId,
        id: randomUUID(),
      });
      delivery = { ...competition, attemptCount: 0 };
    }
    if (delivery?.startedAt == null || delivery.channelId == null) return undefined;
    const [claimed] = await transaction
      .update(competitionStartDeliveries)
      .set({
        attemptCount: sql`${competitionStartDeliveries.attemptCount} + 1`,
        status: 'delivering',
        updatedAt: now,
      })
      .where(
        and(
          eq(competitionStartDeliveries.guildId, guildId),
          eq(competitionStartDeliveries.competitionId, delivery.competitionId),
          dueCondition(now),
        ),
      )
      .returning({ id: competitionStartDeliveries.id });
    if (claimed === undefined) return undefined;
    return {
      attemptCount: delivery.attemptCount + 1,
      channelId: delivery.channelId,
      competitionId: delivery.competitionId,
      displayName: delivery.displayName,
      endsAt: delivery.endsAt,
      guildId,
      metric: { kind: delivery.metricKind, name: delivery.metricName },
      startedAt: delivery.startedAt,
    };
  }

  private async finalize(
    guildId: string,
    competitionId: string,
    status: 'delivered' | 'pending',
    values: Partial<typeof competitionStartDeliveries.$inferInsert>,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await lockGuild(transaction, guildId);
      const [updated] = await transaction
        .update(competitionStartDeliveries)
        .set({ ...values, status, updatedAt: this.now() })
        .where(
          and(
            eq(competitionStartDeliveries.guildId, guildId),
            eq(competitionStartDeliveries.competitionId, competitionId),
            eq(competitionStartDeliveries.status, 'delivering'),
          ),
        )
        .returning({ id: competitionStartDeliveries.id });
      if (updated === undefined)
        throw new Error('Competition start delivery is no longer in progress.');
    });
  }
}

function dueCondition(now: Date) {
  return or(
    and(
      inArray(competitionStartDeliveries.status, ['pending', 'failed']),
      or(
        isNull(competitionStartDeliveries.nextAttemptAt),
        lte(competitionStartDeliveries.nextAttemptAt, now),
      ),
    ),
    and(
      eq(competitionStartDeliveries.status, 'delivering'),
      lte(competitionStartDeliveries.updatedAt, new Date(now.getTime() - LEASE_MS)),
    ),
  );
}

async function lockGuild(transaction: Transaction, guildId: string): Promise<void> {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
}
