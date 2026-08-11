import { describe, expect, it } from 'vitest';

import {
  CompetitionResultDeliveryService,
  type CompetitionResultDeliveryRepository,
  type CompetitionResultPublisher,
  type PendingCompetitionResultDelivery,
} from '../src/features/competitions/deliver-competition-result.js';

describe('competition result delivery', () => {
  it('publishes a durable finished result and records its Discord message', async () => {
    const repository = new RepositoryStub(delivery());
    const service = new CompetitionResultDeliveryService(
      repository,
      { getFinishedResult: () => Promise.resolve(result()) },
      new PublisherStub(),
    );
    await expect(service.recoverDue()).resolves.toBe('delivered');
    expect(repository.successes).toEqual([
      { competitionId: 'competition-one', discordMessageId: 'message-one', guildId: 'guild-one' },
    ]);
  });

  it('keeps a failed result delivery recoverable with a bounded retry time', async () => {
    const repository = new RepositoryStub(delivery());
    const now = new Date('2026-08-11T12:00:00.000Z');
    const service = new CompetitionResultDeliveryService(
      repository,
      { getFinishedResult: () => Promise.resolve(result()) },
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

  it('records a result-read failure for retry instead of leaving the delivery leased', async () => {
    const repository = new RepositoryStub(delivery());
    const now = new Date('2026-08-11T12:00:00.000Z');
    const service = new CompetitionResultDeliveryService(
      repository,
      { getFinishedResult: () => Promise.reject(new Error('result read failed')) },
      new PublisherStub(),
      () => now,
    );

    await expect(service.recoverDue()).resolves.toBe('delivery_failed');
    expect(repository.failures).toEqual([
      {
        competitionId: 'competition-one',
        failureSummary: 'result read failed',
        guildId: 'guild-one',
        nextAttemptAt: new Date('2026-08-11T12:01:00.000Z'),
      },
    ]);
  });
});

class RepositoryStub implements CompetitionResultDeliveryRepository {
  public readonly failures: object[] = [];
  public readonly successes: object[] = [];
  public constructor(private readonly delivery: PendingCompetitionResultDelivery | undefined) {}
  claimDueDelivery() {
    return Promise.resolve(this.delivery);
  }
  recordFailure(value: Parameters<CompetitionResultDeliveryRepository['recordFailure']>[0]) {
    this.failures.push(value);
    return Promise.resolve();
  }
  recordSuccess(value: Parameters<CompetitionResultDeliveryRepository['recordSuccess']>[0]) {
    this.successes.push(value);
    return Promise.resolve();
  }
}
class PublisherStub implements CompetitionResultPublisher {
  public constructor(private readonly error?: Error) {}
  publish() {
    return this.error === undefined
      ? Promise.resolve({ discordMessageId: 'message-one' })
      : Promise.reject(this.error);
  }
}
function delivery(): PendingCompetitionResultDelivery {
  return {
    attemptCount: 1,
    channelId: 'competition-channel',
    competitionId: 'competition-one',
    guildId: 'guild-one',
  };
}
function result() {
  return {
    competitionId: 'competition-one',
    displayName: 'Zulrah weekend',
    entries: [],
    finishedAt: new Date(),
    isResultDelayed: false,
    kind: 'finished_result' as const,
    metric: { kind: 'boss' as const, name: 'Zulrah' },
    targetValue: null,
  };
}
