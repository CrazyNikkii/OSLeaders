import { and, asc, eq, inArray, lte, or, sql } from 'drizzle-orm';

import type {
  DailyRecapDeliveryRepository,
  PendingDailyRecapDelivery,
} from '../../features/recaps/deliver-daily-recap.js';
import type { Database, Transaction } from './connection.js';
import { dailyRecapDeliveries, dailyRecapRuns } from './schema/index.js';

const DELIVERY_LEASE_MS = 5 * 60 * 1_000;

export class PostgresDailyRecapDeliveryRepository implements DailyRecapDeliveryRepository {
  public constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public claimPendingDelivery(
    guildId: string,
    recapRunId: string,
  ): Promise<PendingDailyRecapDelivery | undefined> {
    return this.claimDelivery(guildId, recapRunId, false);
  }

  public claimRecoverableDelivery(guildId: string): Promise<PendingDailyRecapDelivery | undefined> {
    return this.claimDelivery(guildId, undefined, true);
  }

  public claimDueRecoverableDelivery(): Promise<PendingDailyRecapDelivery | undefined> {
    return this.database.transaction(async (transaction) => {
      const now = this.now();
      const [candidate] = await transaction
        .select({ guildId: dailyRecapDeliveries.guildId })
        .from(dailyRecapDeliveries)
        .innerJoin(
          dailyRecapRuns,
          and(
            eq(dailyRecapRuns.id, dailyRecapDeliveries.recapRunId),
            eq(dailyRecapRuns.guildId, dailyRecapDeliveries.guildId),
          ),
        )
        .where(
          and(dueRecoverableDeliveryCondition(now), eq(dailyRecapRuns.status, 'delivery_pending')),
        )
        .orderBy(asc(dailyRecapDeliveries.nextAttemptAt), asc(dailyRecapDeliveries.createdAt))
        .limit(1);
      if (candidate === undefined) {
        return undefined;
      }
      await lockGuild(transaction, candidate.guildId);
      return this.claimDeliveryInTransaction(
        transaction,
        candidate.guildId,
        undefined,
        true,
        true,
        now,
      );
    });
  }

  public async recordDeliverySuccess(
    guildId: string,
    recapRunId: string,
    discordMessageId: string,
  ): Promise<void> {
    await this.finalize(guildId, recapRunId, 'delivered', {
      deliveredAt: this.now(),
      discordMessageId,
    });
  }

  public async recordDeliveryFailure(
    guildId: string,
    recapRunId: string,
    failureSummary: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.finalize(guildId, recapRunId, 'pending', {
      lastFailureSummary: failureSummary.slice(0, 500),
      nextAttemptAt,
    });
  }

  private async claimDelivery(
    guildId: string,
    requestedRunId?: string,
    recoverable = false,
  ): Promise<PendingDailyRecapDelivery | undefined> {
    return this.database.transaction(async (transaction) => {
      await lockGuild(transaction, guildId);
      return this.claimDeliveryInTransaction(
        transaction,
        guildId,
        requestedRunId,
        recoverable,
        false,
        this.now(),
      );
    });
  }

  private async claimDeliveryInTransaction(
    transaction: Transaction,
    guildId: string,
    requestedRunId: string | undefined,
    recoverable: boolean,
    dueOnly: boolean,
    now: Date,
  ): Promise<PendingDailyRecapDelivery | undefined> {
    const conditions = [
      eq(dailyRecapDeliveries.guildId, guildId),
      dueOnly
        ? dueRecoverableDeliveryCondition(now)
        : recoverable
          ? recoverableDeliveryCondition(now)
          : eq(dailyRecapDeliveries.status, 'pending'),
      eq(dailyRecapRuns.status, 'delivery_pending'),
    ];
    if (requestedRunId !== undefined) {
      conditions.push(eq(dailyRecapDeliveries.recapRunId, requestedRunId));
    }
    const [delivery] = await transaction
      .select({
        attemptCount: dailyRecapDeliveries.attemptCount,
        channelId: dailyRecapDeliveries.channelId,
        content: dailyRecapDeliveries.content,
        recapRunId: dailyRecapDeliveries.recapRunId,
      })
      .from(dailyRecapDeliveries)
      .innerJoin(
        dailyRecapRuns,
        and(
          eq(dailyRecapRuns.id, dailyRecapDeliveries.recapRunId),
          eq(dailyRecapRuns.guildId, dailyRecapDeliveries.guildId),
        ),
      )
      .where(and(...conditions))
      .orderBy(asc(dailyRecapDeliveries.createdAt))
      .limit(1);
    if (delivery === undefined) {
      return undefined;
    }
    const [claimed] = await transaction
      .update(dailyRecapDeliveries)
      .set({
        attemptCount: sql`${dailyRecapDeliveries.attemptCount} + 1`,
        status: 'delivering',
        updatedAt: now,
      })
      .where(
        and(
          eq(dailyRecapDeliveries.guildId, guildId),
          eq(dailyRecapDeliveries.recapRunId, delivery.recapRunId),
          recoverable
            ? dueOnly
              ? dueRecoverableDeliveryCondition(now)
              : recoverableDeliveryCondition(now)
            : eq(dailyRecapDeliveries.status, 'pending'),
        ),
      )
      .returning({ recapRunId: dailyRecapDeliveries.recapRunId });
    if (claimed === undefined) {
      return undefined;
    }
    return { ...delivery, attemptCount: delivery.attemptCount + 1, guildId };
  }

  private async finalize(
    guildId: string,
    recapRunId: string,
    status: 'delivered' | 'pending',
    deliveryValues: Partial<typeof dailyRecapDeliveries.$inferInsert>,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await lockGuild(transaction, guildId);
      const now = this.now();
      const [delivery] = await transaction
        .update(dailyRecapDeliveries)
        .set({ ...deliveryValues, status, updatedAt: now })
        .where(
          and(
            eq(dailyRecapDeliveries.guildId, guildId),
            eq(dailyRecapDeliveries.recapRunId, recapRunId),
            eq(dailyRecapDeliveries.status, 'delivering'),
          ),
        )
        .returning({ recapRunId: dailyRecapDeliveries.recapRunId });
      if (delivery === undefined) {
        throw new Error('Daily recap delivery is no longer in progress.');
      }
      if (status === 'delivered') {
        const [run] = await transaction
          .update(dailyRecapRuns)
          .set({ status, updatedAt: now })
          .where(
            and(
              eq(dailyRecapRuns.guildId, guildId),
              eq(dailyRecapRuns.id, recapRunId),
              eq(dailyRecapRuns.status, 'delivery_pending'),
            ),
          )
          .returning({ id: dailyRecapRuns.id });
        if (run === undefined) {
          throw new Error('Daily recap run is no longer awaiting delivery.');
        }
      }
    });
  }
}

function recoverableDeliveryCondition(now: Date) {
  return or(
    inArray(dailyRecapDeliveries.status, ['pending', 'failed']),
    and(
      eq(dailyRecapDeliveries.status, 'delivering'),
      lte(dailyRecapDeliveries.updatedAt, new Date(now.getTime() - DELIVERY_LEASE_MS)),
    ),
  );
}

function dueRecoverableDeliveryCondition(now: Date) {
  return or(
    and(
      inArray(dailyRecapDeliveries.status, ['pending', 'failed']),
      or(
        sql`${dailyRecapDeliveries.nextAttemptAt} IS NULL`,
        lte(dailyRecapDeliveries.nextAttemptAt, now),
      ),
    ),
    and(
      eq(dailyRecapDeliveries.status, 'delivering'),
      lte(dailyRecapDeliveries.updatedAt, new Date(now.getTime() - DELIVERY_LEASE_MS)),
    ),
  );
}

async function lockGuild(transaction: Transaction, guildId: string): Promise<void> {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
}
