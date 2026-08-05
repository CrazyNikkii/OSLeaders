import type { DailyRecapCollectionResult } from './daily-recap-collection.js';
import {
  assertCollectionBelongsToGuild,
  renderDailyRecapDeliveryContent,
} from './send-daily-recap.js';
import { presentDailyRecap } from './daily-recap-presentation.js';

export interface ClaimedAutomaticDailyRecapRun {
  collectionAttemptCount: number;
  guildId: string;
  recapChannelId: string;
  recapRunId: string;
}

export interface FinalizeAutomaticDailyRecapRunRequest {
  collection: DailyRecapCollectionResult;
  deliveryContent: string;
  guildId: string;
  recapChannelId: string;
  recapRunId: string;
}

export interface AutomaticDailyRecapCollectionRepository {
  claimDueRun(): Promise<ClaimedAutomaticDailyRecapRun | undefined>;
  failRun(
    guildId: string,
    recapRunId: string,
    failureSummary: string,
    nextAttemptAt: Date,
  ): Promise<void>;
  finalizeRun(request: FinalizeAutomaticDailyRecapRunRequest): Promise<void>;
}

export interface AutomaticDailyRecapCollector {
  collect(guildId: string): Promise<DailyRecapCollectionResult>;
}

export type AutomaticDailyRecapCollectionResult =
  | { kind: 'no_due_recap' }
  | { guildId: string; kind: 'ready_for_delivery'; recapRunId: string }
  | { guildId: string; kind: 'collection_failed'; recapRunId: string };

export class AutomaticDailyRecapCollectionService {
  public constructor(
    private readonly repository: AutomaticDailyRecapCollectionRepository,
    private readonly collector: AutomaticDailyRecapCollector,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async collectDue(): Promise<AutomaticDailyRecapCollectionResult> {
    const run = await this.repository.claimDueRun();
    if (run === undefined) {
      return { kind: 'no_due_recap' };
    }

    try {
      const collection = await this.collector.collect(run.guildId);
      assertCollectionBelongsToGuild(collection, run.guildId);
      await this.repository.finalizeRun({
        collection,
        deliveryContent: renderDailyRecapDeliveryContent(presentDailyRecap(collection)),
        guildId: run.guildId,
        recapChannelId: run.recapChannelId,
        recapRunId: run.recapRunId,
      });
      return { guildId: run.guildId, kind: 'ready_for_delivery', recapRunId: run.recapRunId };
    } catch (error) {
      await this.repository.failRun(
        run.guildId,
        run.recapRunId,
        failureSummary(error),
        new Date(this.now().getTime() + retryDelayMs(run.collectionAttemptCount)),
      );
      return { guildId: run.guildId, kind: 'collection_failed', recapRunId: run.recapRunId };
    }
  }
}

export function retryDelayMs(collectionAttemptCount: number): number {
  const retryDelays = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
  return retryDelays[Math.min(Math.max(collectionAttemptCount - 1, 0), retryDelays.length - 1)]!;
}

function failureSummary(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : 'Unexpected automatic recap collection failure.';
}
