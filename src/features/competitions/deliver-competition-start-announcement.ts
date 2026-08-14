import type { CompetitionMetric } from './create-competition.js';
import { retryDelayMs } from './deliver-competition-result.js';

export interface PendingCompetitionStartDelivery {
  attemptCount: number;
  channelId: string;
  competitionId: string;
  displayName: string;
  endsAt: Date | null;
  guildId: string;
  metric: CompetitionMetric;
  startedAt: Date;
}

export interface CompetitionStartDeliveryRepository {
  claimDelivery(request: {
    competitionId: string;
    guildId: string;
  }): Promise<PendingCompetitionStartDelivery | undefined>;
  claimDueDelivery(): Promise<PendingCompetitionStartDelivery | undefined>;
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

export interface CompetitionStartPublisher {
  publish(delivery: PendingCompetitionStartDelivery): Promise<{ discordMessageId: string }>;
}

export class CompetitionStartAnnouncementDeliveryService {
  public constructor(
    private readonly repository: CompetitionStartDeliveryRepository,
    private readonly publisher: CompetitionStartPublisher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async deliverNow(request: { competitionId: string; guildId: string }) {
    return this.deliver(await this.repository.claimDelivery(request));
  }

  public async recoverDue(): Promise<'delivered' | 'delivery_failed' | 'no_delivery'> {
    return this.deliver(await this.repository.claimDueDelivery());
  }

  private async deliver(delivery: PendingCompetitionStartDelivery | undefined) {
    if (delivery === undefined) return 'no_delivery' as const;
    try {
      const published = await this.publisher.publish(delivery);
      await this.repository.recordSuccess({
        competitionId: delivery.competitionId,
        discordMessageId: published.discordMessageId,
        guildId: delivery.guildId,
      });
      return 'delivered' as const;
    } catch (error) {
      await this.repository.recordFailure({
        competitionId: delivery.competitionId,
        failureSummary:
          error instanceof Error
            ? error.message.slice(0, 500)
            : 'Unexpected Discord competition-start delivery failure.',
        guildId: delivery.guildId,
        nextAttemptAt: new Date(this.now().getTime() + retryDelayMs(delivery.attemptCount)),
      });
      return 'delivery_failed' as const;
    }
  }
}
