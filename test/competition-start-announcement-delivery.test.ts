import { describe, expect, it } from 'vitest';

import {
  CompetitionStartAnnouncementDeliveryService,
  type CompetitionStartDeliveryRepository,
  type CompetitionStartPublisher,
  type PendingCompetitionStartDelivery,
} from '../src/features/competitions/deliver-competition-start-announcement.js';

describe('competition start announcement delivery', () => {
  it('records a successful immediate announcement delivery', async () => {
    const repository = new RepositoryStub(delivery());
    const service = new CompetitionStartAnnouncementDeliveryService(
      repository,
      new PublisherStub(),
    );

    await expect(
      service.deliverNow({ competitionId: 'competition-one', guildId: 'guild-one' }),
    ).resolves.toBe('delivered');
    expect(repository.successes).toEqual([
      { competitionId: 'competition-one', discordMessageId: 'message-one', guildId: 'guild-one' },
    ]);
  });

  it('keeps a failed delivery recoverable with a bounded retry and lets recovery deliver it', async () => {
    const repository = new RepositoryStub(delivery());
    const now = new Date('2026-08-11T12:00:00.000Z');
    const service = new CompetitionStartAnnouncementDeliveryService(
      repository,
      new PublisherStub(new Error('channel unavailable')),
      () => now,
    );

    await expect(service.recoverDue()).resolves.toBe('delivery_failed');
    expect(repository.failures).toEqual([
      {
        competitionId: 'competition-one',
        failureSummary: 'channel unavailable',
        guildId: 'guild-one',
        nextAttemptAt: new Date('2026-08-11T12:01:00.000Z'),
      },
    ]);
  });
});

class RepositoryStub implements CompetitionStartDeliveryRepository {
  public readonly failures: object[] = [];
  public readonly successes: object[] = [];
  public constructor(private readonly delivery: PendingCompetitionStartDelivery | undefined) {}
  claimDelivery() {
    return Promise.resolve(this.delivery);
  }
  claimDueDelivery() {
    return Promise.resolve(this.delivery);
  }
  recordFailure(value: Parameters<CompetitionStartDeliveryRepository['recordFailure']>[0]) {
    this.failures.push(value);
    return Promise.resolve();
  }
  recordSuccess(value: Parameters<CompetitionStartDeliveryRepository['recordSuccess']>[0]) {
    this.successes.push(value);
    return Promise.resolve();
  }
}

class PublisherStub implements CompetitionStartPublisher {
  public constructor(private readonly error?: Error) {}
  publish() {
    return this.error === undefined
      ? Promise.resolve({ discordMessageId: 'message-one' })
      : Promise.reject(this.error);
  }
}

function delivery(): PendingCompetitionStartDelivery {
  return {
    attemptCount: 1,
    channelId: 'competition-channel',
    competitionId: 'competition-one',
    displayName: 'Mining week',
    endsAt: null,
    guildId: 'guild-one',
    metric: { kind: 'skill', name: 'Woodcutting' },
    startedAt: new Date('2026-08-10T12:00:00.000Z'),
  };
}
