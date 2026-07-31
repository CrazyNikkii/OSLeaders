export interface PendingDailyRecapDelivery {
  attemptCount: number;
  channelId: string;
  content: string;
  guildId: string;
  recapRunId: string;
}

export interface DailyRecapDeliveryRepository {
  claimPendingDelivery(
    guildId: string,
    recapRunId: string,
  ): Promise<PendingDailyRecapDelivery | undefined>;
  claimRecoverableDelivery(guildId: string): Promise<PendingDailyRecapDelivery | undefined>;
  claimDueRecoverableDelivery(): Promise<PendingDailyRecapDelivery | undefined>;
  recordDeliveryFailure(
    guildId: string,
    recapRunId: string,
    failureSummary: string,
    nextAttemptAt: Date,
  ): Promise<void>;
  recordDeliverySuccess(
    guildId: string,
    recapRunId: string,
    discordMessageId: string,
  ): Promise<void>;
}

export interface DailyRecapPublisher {
  publish(delivery: PendingDailyRecapDelivery): Promise<{ discordMessageId: string }>;
}

export type DailyRecapDeliveryResult =
  | { kind: 'delivered'; discordMessageId: string }
  | { kind: 'delivery_failed' }
  | { kind: 'delivery_not_pending' };

export type DailyRecapRecoveryResult =
  DailyRecapDeliveryResult | { kind: 'no_recoverable_delivery' };

export class DailyRecapDeliveryService {
  public constructor(
    private readonly repository: DailyRecapDeliveryRepository,
    private readonly publisher: DailyRecapPublisher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async deliver(guildId: string, recapRunId: string): Promise<DailyRecapDeliveryResult> {
    const delivery = await this.repository.claimPendingDelivery(guildId, recapRunId);
    if (delivery === undefined) {
      return { kind: 'delivery_not_pending' };
    }

    return this.publishClaimedDelivery(delivery);
  }

  public async recover(guildId: string): Promise<DailyRecapRecoveryResult> {
    const delivery = await this.repository.claimRecoverableDelivery(guildId);
    if (delivery === undefined) {
      return { kind: 'no_recoverable_delivery' };
    }
    return this.publishClaimedDelivery(delivery);
  }

  public async recoverDue(): Promise<DailyRecapRecoveryResult> {
    const delivery = await this.repository.claimDueRecoverableDelivery();
    if (delivery === undefined) {
      return { kind: 'no_recoverable_delivery' };
    }
    return this.publishClaimedDelivery(delivery);
  }

  private async publishClaimedDelivery(
    delivery: PendingDailyRecapDelivery,
  ): Promise<DailyRecapDeliveryResult> {
    try {
      const published = await this.publisher.publish(delivery);
      await this.repository.recordDeliverySuccess(
        delivery.guildId,
        delivery.recapRunId,
        published.discordMessageId,
      );
      return { discordMessageId: published.discordMessageId, kind: 'delivered' };
    } catch (error) {
      await this.repository.recordDeliveryFailure(
        delivery.guildId,
        delivery.recapRunId,
        failureSummary(error),
        new Date(this.now().getTime() + retryDelayMs(delivery.attemptCount)),
      );
      return { kind: 'delivery_failed' };
    }
  }
}

export function retryDelayMs(attemptCount: number): number {
  const retryDelays = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
  return retryDelays[Math.min(Math.max(attemptCount - 1, 0), retryDelays.length - 1)]!;
}

function failureSummary(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : 'Unexpected Discord recap-delivery failure.';
}
