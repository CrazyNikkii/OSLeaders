import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type {
  FinalizeManualDailyRecapRunRequest,
  ManualDailyRecapSendRepository,
  StartManualDailyRecapRunResult,
} from '../../features/recaps/send-daily-recap.js';
import {
  assertCollectionBelongsToGuild,
  successfulBaselineReplacements,
} from '../../features/recaps/send-daily-recap.js';
import type { Database } from './connection.js';
import {
  dailyRecapDeliveries,
  dailyRecapRuns,
  guildConfigurations,
  recapBaselines,
} from './schema/index.js';

const ACTIVE_RECAP_RUN_STATUSES = ['pending_collection', 'collecting', 'delivery_pending'] as const;

export class PostgresManualDailyRecapSendRepository implements ManualDailyRecapSendRepository {
  public constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async startManualRun(
    guildId: string,
    recapRunId: string,
  ): Promise<StartManualDailyRecapRunResult> {
    return this.database.transaction(async (transaction) => {
      await lockGuild(transaction, guildId);
      const [configuration] = await transaction
        .select({ recapChannelId: guildConfigurations.recapChannelId })
        .from(guildConfigurations)
        .where(eq(guildConfigurations.guildId, guildId));
      if (configuration?.recapChannelId === null || configuration === undefined) {
        return { kind: 'recap_not_configured' };
      }

      const [activeRun] = await transaction
        .select({ id: dailyRecapRuns.id })
        .from(dailyRecapRuns)
        .where(
          and(
            eq(dailyRecapRuns.guildId, guildId),
            inArray(dailyRecapRuns.status, ACTIVE_RECAP_RUN_STATUSES),
          ),
        )
        .orderBy(desc(dailyRecapRuns.createdAt))
        .limit(1);
      if (activeRun !== undefined) {
        return { kind: 'recap_already_running' };
      }

      const now = this.now();
      await transaction.insert(dailyRecapRuns).values({
        collectionAttemptCount: 1,
        collectionStartedAt: now,
        guildId,
        id: recapRunId,
        status: 'collecting',
        trigger: 'manual',
        updatedAt: now,
      });
      return { kind: 'started', run: { recapChannelId: configuration.recapChannelId, recapRunId } };
    });
  }

  public async finalizeManualRun(request: FinalizeManualDailyRecapRunRequest): Promise<void> {
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
        throw new Error('Daily recap run is no longer collecting.');
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
          status: 'delivery_pending',
          updatedAt: now,
        })
        .where(
          and(
            eq(dailyRecapRuns.guildId, request.guildId),
            eq(dailyRecapRuns.id, request.recapRunId),
          ),
        );
    });
  }

  public async failManualRun(
    guildId: string,
    recapRunId: string,
    failureSummary: string,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await lockGuild(transaction, guildId);
      await transaction
        .update(dailyRecapRuns)
        .set({
          lastCollectionFailureSummary: failureSummary,
          status: 'failed',
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
}

async function lockGuild(
  transaction: Parameters<Parameters<Database['transaction']>[0]>[0],
  guildId: string,
): Promise<void> {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
}
