import type { CompetitionResultsHistoryResult } from './competition-results-history.js';

export interface PendingCompetitionResultDelivery {
  attemptCount: number;
  channelId: string;
  competitionId: string;
  guildId: string;
}

export interface CompetitionResultDeliveryRepository {
  claimDueDelivery(): Promise<PendingCompetitionResultDelivery | undefined>;
  recordFailure(request: {
    competitionId: string;
    failureSummary: string;
    guildId: string;
    nextAttemptAt: Date;
  }): Promise<void>;
  recordSuccess(request: {
    competitionId: string;
    discordMessageId: string;
    guildId: string;
  }): Promise<void>;
}

export interface CompetitionResultPublisher {
  publish(
    delivery: PendingCompetitionResultDelivery,
    result: Extract<
      CompetitionResultsHistoryResult,
      { kind: 'finished_result' | 'cancelled_result' }
    >,
  ): Promise<{ discordMessageId: string }>;
}

export class CompetitionResultDeliveryService {
  public constructor(
    private readonly repository: CompetitionResultDeliveryRepository,
    private readonly results: {
      getFinishedResult(request: {
        competitionId: string;
        guildId: string;
      }): Promise<CompetitionResultsHistoryResult>;
    },
    private readonly publisher: CompetitionResultPublisher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async recoverDue(): Promise<'delivered' | 'delivery_failed' | 'no_delivery'> {
    const delivery = await this.repository.claimDueDelivery();
    if (delivery === undefined) return 'no_delivery';
    try {
      const result = await this.results.getFinishedResult(delivery);
      if (result.kind !== 'finished_result' && result.kind !== 'cancelled_result') {
        await this.recordFailure(
          delivery,
          'Completed competition notification is not available for delivery.',
        );
        return 'delivery_failed';
      }
      const published = await this.publisher.publish(delivery, result);
      await this.repository.recordSuccess({
        competitionId: delivery.competitionId,
        discordMessageId: published.discordMessageId,
        guildId: delivery.guildId,
      });
      return 'delivered';
    } catch (error) {
      await this.recordFailure(
        delivery,
        error instanceof Error
          ? error.message
          : 'Unexpected Discord competition-result delivery failure.',
      );
      return 'delivery_failed';
    }
  }

  private recordFailure(delivery: PendingCompetitionResultDelivery, failureSummary: string) {
    return this.repository.recordFailure({
      competitionId: delivery.competitionId,
      failureSummary: failureSummary.slice(0, 500),
      guildId: delivery.guildId,
      nextAttemptAt: new Date(this.now().getTime() + retryDelayMs(delivery.attemptCount)),
    });
  }
}

export function retryDelayMs(attemptCount: number): number {
  const delays = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
  return delays[Math.min(Math.max(attemptCount - 1, 0), delays.length - 1)]!;
}
