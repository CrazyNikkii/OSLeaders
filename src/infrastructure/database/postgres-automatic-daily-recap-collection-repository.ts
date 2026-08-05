import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';

import type {
  AutomaticDailyRecapCollectionRepository,
  ClaimedAutomaticDailyRecapRun,
  FinalizeAutomaticDailyRecapRunRequest,
} from '../../features/recaps/collect-automatic-daily-recap.js';
import {
  assertCollectionBelongsToGuild,
  successfulBaselineReplacements,
} from '../../features/recaps/send-daily-recap.js';
import type { Database, Transaction } from './connection.js';
import {
  dailyRecapDeliveries,
  dailyRecapRuns,
  guildConfigurations,
  recapBaselines,
} from './schema/index.js';

const COLLECTION_LEASE_MS = 5 * 60 * 1_000;

export class PostgresAutomaticDailyRecapCollectionRepository implements AutomaticDailyRecapCollectionRepository {
  public constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async claimDueRun(): Promise<ClaimedAutomaticDailyRecapRun | undefined> {
    return this.database.transaction(async (transaction) => {
      const now = this.now();
      while (true) {
        const [candidate] = await transaction
          .select({ guildId: dailyRecapRuns.guildId })
          .from(dailyRecapRuns)
          .where(and(eq(dailyRecapRuns.trigger, 'automatic'), dueCollectionCondition(now)))
          .orderBy(asc(dailyRecapRuns.nextCollectionAttemptAt), asc(dailyRecapRuns.scheduledFor))
          .limit(1);
        if (candidate === undefined) {
          return undefined;
        }
        await lockGuild(transaction, candidate.guildId);
        const claimed = await this.claimDueRunInTransaction(transaction, candidate.guildId, now);
        if (claimed !== undefined) {
          return claimed;
        }
      }
    });
  }

  public async finalizeRun(request: FinalizeAutomaticDailyRecapRunRequest): Promise<void> {
    assertCollectionBelongsToGuild(request.collection, request.guildId);
    await this.database.transaction(async (transaction) => {
      await lockGuild(transaction, request.guildId);
      const [run] = await transaction
        .select({ id: dailyRecapRuns.id })
        .from(dailyRecapRuns)
        .where(
          and(
            eq(dailyRecapRuns.guildId, request.guildId),
            eq(dailyRecapRuns.id, request.recapRunId),
            eq(dailyRecapRuns.status, 'collecting'),
          ),
        );
      if (run === undefined) {
        throw new Error('Automatic daily recap run is no longer collecting.');
      }

      for (const replacement of successfulBaselineReplacements(request.collection.outcomes)) {
        const [updatedBaseline] = await transaction
          .update(recapBaselines)
          .set({
            bossKillCounts: replacement.baseline.bossKillCounts,
            capturedAt: replacement.baseline.capturedAt,
            skillExperience: replacement.baseline.skillExperience,
            skillLevels: replacement.baseline.skillLevels,
          })
          .where(
            and(
              eq(recapBaselines.accountId, replacement.accountId),
              eq(recapBaselines.guildId, request.guildId),
            ),
          )
          .returning({ accountId: recapBaselines.accountId });
        if (updatedBaseline === undefined) {
          throw new Error('A recap baseline changed while collection was in progress.');
        }
      }

      const now = this.now();
      await transaction.insert(dailyRecapDeliveries).values({
        channelId: request.recapChannelId,
        content: request.deliveryContent,
        guildId: request.guildId,
        id: request.recapRunId,
        recapRunId: request.recapRunId,
      });
      await transaction
        .update(dailyRecapRuns)
        .set({
          accountOutcomes: request.collection.outcomes,
          collectionCompletedAt: request.collection.completedAt,
          comparisonCompletedAt: request.collection.completedAt,
          comparisonStartedAt: request.collection.startedAt,
          lastCollectionFailureSummary: null,
          nextCollectionAttemptAt: null,
          status: 'delivery_pending',
          updatedAt: now,
        })
        .where(
          and(
            eq(dailyRecapRuns.guildId, request.guildId),
            eq(dailyRecapRuns.id, request.recapRunId),
            eq(dailyRecapRuns.status, 'collecting'),
          ),
        );
    });
  }

  public async failRun(
    guildId: string,
    recapRunId: string,
    failureSummary: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await lockGuild(transaction, guildId);
      await transaction
        .update(dailyRecapRuns)
        .set({
          lastCollectionFailureSummary: failureSummary.slice(0, 500),
          nextCollectionAttemptAt: nextAttemptAt,
          status: 'pending_collection',
          updatedAt: this.now(),
        })
        .where(
          and(
            eq(dailyRecapRuns.guildId, guildId),
            eq(dailyRecapRuns.id, recapRunId),
            eq(dailyRecapRuns.status, 'collecting'),
          ),
        );
    });
  }

  private async claimDueRunInTransaction(
    transaction: Transaction,
    guildId: string,
    now: Date,
  ): Promise<ClaimedAutomaticDailyRecapRun | undefined> {
    const [run] = await transaction
      .select({
        collectionAttemptCount: dailyRecapRuns.collectionAttemptCount,
        id: dailyRecapRuns.id,
      })
      .from(dailyRecapRuns)
      .where(
        and(
          eq(dailyRecapRuns.guildId, guildId),
          eq(dailyRecapRuns.trigger, 'automatic'),
          dueCollectionCondition(now),
        ),
      )
      .orderBy(asc(dailyRecapRuns.nextCollectionAttemptAt), asc(dailyRecapRuns.scheduledFor))
      .limit(1);
    if (run === undefined) {
      return undefined;
    }
    const [configuration] = await transaction
      .select({
        recapChannelId: guildConfigurations.recapChannelId,
        recapEnabled: guildConfigurations.recapEnabled,
      })
      .from(guildConfigurations)
      .where(eq(guildConfigurations.guildId, guildId));
    if (!configuration?.recapEnabled || configuration.recapChannelId === null) {
      await transaction
        .update(dailyRecapRuns)
        .set({
          lastCollectionFailureSummary: 'Automatic daily recap is no longer configured.',
          status: 'failed',
          updatedAt: now,
        })
        .where(and(eq(dailyRecapRuns.guildId, guildId), eq(dailyRecapRuns.id, run.id)));
      return undefined;
    }
    const [claimed] = await transaction
      .update(dailyRecapRuns)
      .set({
        collectionAttemptCount: sql`${dailyRecapRuns.collectionAttemptCount} + 1`,
        collectionStartedAt: now,
        nextCollectionAttemptAt: null,
        status: 'collecting',
        updatedAt: now,
      })
      .where(
        and(
          eq(dailyRecapRuns.guildId, guildId),
          eq(dailyRecapRuns.id, run.id),
          dueCollectionCondition(now),
        ),
      )
      .returning({ id: dailyRecapRuns.id });
    if (claimed === undefined) {
      return undefined;
    }
    return {
      collectionAttemptCount: run.collectionAttemptCount + 1,
      guildId,
      recapChannelId: configuration.recapChannelId,
      recapRunId: run.id,
    };
  }
}

function dueCollectionCondition(now: Date) {
  return or(
    and(
      eq(dailyRecapRuns.status, 'pending_collection'),
      or(
        and(isNull(dailyRecapRuns.nextCollectionAttemptAt), lte(dailyRecapRuns.scheduledFor, now)),
        lte(dailyRecapRuns.nextCollectionAttemptAt, now),
      ),
    ),
    and(
      eq(dailyRecapRuns.status, 'collecting'),
      lte(dailyRecapRuns.collectionStartedAt, new Date(now.getTime() - COLLECTION_LEASE_MS)),
    ),
  );
}

async function lockGuild(transaction: Transaction, guildId: string): Promise<void> {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
}
