import { describe, expect, it } from 'vitest';

import {
  DailyRecapDeliveryService,
  retryDelayMs,
  type DailyRecapDeliveryRepository,
  type DailyRecapPublisher,
  type PendingDailyRecapDelivery,
} from '../src/features/recaps/deliver-daily-recap.js';

describe('daily recap delivery service', () => {
  it('claims a pending guild delivery, publishes it, and persists the Discord message reference', async () => {
    const repository = new RepositoryStub(delivery());
    const publisher = new PublisherStub();
    const service = new DailyRecapDeliveryService(repository, publisher);

    await expect(service.deliver('guild-one', 'run-one')).resolves.toEqual({
      discordMessageId: 'message-one',
      kind: 'delivered',
    });
    expect(publisher.deliveries).toEqual([delivery()]);
    expect(repository.successes).toEqual([
      { discordMessageId: 'message-one', guildId: 'guild-one', recapRunId: 'run-one' },
    ]);
    expect(repository.failures).toEqual([]);
  });

  it('does not publish a delivery that is absent, claimed, or from another guild', async () => {
    const repository = new RepositoryStub(undefined);
    const publisher = new PublisherStub();

    await expect(
      new DailyRecapDeliveryService(repository, publisher).deliver('guild-one', 'run-one'),
    ).resolves.toEqual({
      kind: 'delivery_not_pending',
    });
    expect(publisher.deliveries).toEqual([]);
  });

  it('records a bounded failure after Discord rejects a claimed delivery', async () => {
    const repository = new RepositoryStub(delivery());
    const publisher = new PublisherStub(new Error('Discord channel unavailable.'));
    const now = new Date('2026-07-31T12:00:00.000Z');

    await expect(
      new DailyRecapDeliveryService(repository, publisher, () => now).deliver(
        'guild-one',
        'run-one',
      ),
    ).resolves.toEqual({
      kind: 'delivery_failed',
    });
    expect(repository.failures).toEqual([
      {
        failureSummary: 'Discord channel unavailable.',
        guildId: 'guild-one',
        nextAttemptAt: new Date('2026-07-31T12:01:00.000Z'),
        recapRunId: 'run-one',
      },
    ]);
    expect(repository.successes).toEqual([]);
  });

  it('uses progressively delayed, capped retry intervals', () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(5 * 60_000);
    expect(retryDelayMs(3)).toBe(15 * 60_000);
    expect(retryDelayMs(99)).toBe(30 * 60_000);
  });
});

class RepositoryStub implements DailyRecapDeliveryRepository {
  public readonly failures: {
    failureSummary: string;
    guildId: string;
    nextAttemptAt: Date;
    recapRunId: string;
  }[] = [];
  public readonly successes: { discordMessageId: string; guildId: string; recapRunId: string }[] =
    [];

  public constructor(private readonly pending: PendingDailyRecapDelivery | undefined) {}

  public claimPendingDelivery(): Promise<PendingDailyRecapDelivery | undefined> {
    return Promise.resolve(this.pending);
  }

  public claimRecoverableDelivery(): Promise<PendingDailyRecapDelivery | undefined> {
    return Promise.resolve(this.pending);
  }

  public claimDueRecoverableDelivery(): Promise<PendingDailyRecapDelivery | undefined> {
    return Promise.resolve(this.pending);
  }

  public recordDeliveryFailure(
    guildId: string,
    recapRunId: string,
    failureSummary: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    this.failures.push({ failureSummary, guildId, nextAttemptAt, recapRunId });
    return Promise.resolve();
  }

  public recordDeliverySuccess(
    guildId: string,
    recapRunId: string,
    discordMessageId: string,
  ): Promise<void> {
    this.successes.push({ discordMessageId, guildId, recapRunId });
    return Promise.resolve();
  }
}

class PublisherStub implements DailyRecapPublisher {
  public readonly deliveries: PendingDailyRecapDelivery[] = [];

  public constructor(private readonly error?: Error) {}

  public publish(deliveryValue: PendingDailyRecapDelivery): Promise<{ discordMessageId: string }> {
    this.deliveries.push(deliveryValue);
    if (this.error !== undefined) {
      return Promise.reject(this.error);
    }
    return Promise.resolve({ discordMessageId: 'message-one' });
  }
}

function delivery(): PendingDailyRecapDelivery {
  return {
    attemptCount: 1,
    channelId: 'channel-one',
    content: '# Daily recap',
    guildId: 'guild-one',
    recapRunId: 'run-one',
  };
}
