import { describe, expect, it } from 'vitest';

import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import {
  AutomaticDailyRecapCollectionService,
  retryDelayMs,
  type AutomaticDailyRecapCollectionRepository,
  type ClaimedAutomaticDailyRecapRun,
  type FinalizeAutomaticDailyRecapRunRequest,
} from '../src/features/recaps/collect-automatic-daily-recap.js';
import type { DailyRecapCollectionResult } from '../src/features/recaps/daily-recap-collection.js';

describe('automatic daily recap collection service', () => {
  it('finalizes a due run with a durable delivery payload', async () => {
    const repository = new RepositoryStub(claimedRun());
    const service = new AutomaticDailyRecapCollectionService(
      repository,
      new CollectorStub(collection()),
    );

    await expect(service.collectDue()).resolves.toEqual({
      guildId: 'guild-one',
      kind: 'ready_for_delivery',
      recapRunId: 'automatic-run-one',
    });
    expect(repository.finalized).toEqual([
      expect.objectContaining({
        guildId: 'guild-one',
        recapChannelId: 'recap-channel',
        recapRunId: 'automatic-run-one',
      }),
    ]);
    expect(repository.finalized[0]?.deliveryContent).toContain('\u2022 Zulrah: +3 KC');
    expect(repository.failed).toEqual([]);
  });

  it('does nothing when no automatic recap is due', async () => {
    const repository = new RepositoryStub(undefined);
    const service = new AutomaticDailyRecapCollectionService(
      repository,
      new CollectorStub(collection()),
    );

    await expect(service.collectDue()).resolves.toEqual({ kind: 'no_due_recap' });
    expect(repository.finalized).toEqual([]);
  });

  it('returns the run to the retry queue when collection fails', async () => {
    const repository = new RepositoryStub({ ...claimedRun(), collectionAttemptCount: 2 });
    const now = new Date('2026-08-05T12:00:00.000Z');
    const service = new AutomaticDailyRecapCollectionService(
      repository,
      new ThrowingCollector(),
      () => now,
    );

    await expect(service.collectDue()).resolves.toEqual({
      guildId: 'guild-one',
      kind: 'collection_failed',
      recapRunId: 'automatic-run-one',
    });
    expect(repository.failed).toEqual([
      {
        failureSummary: 'Hiscores crashed.',
        guildId: 'guild-one',
        nextAttemptAt: new Date('2026-08-05T12:05:00.000Z'),
        recapRunId: 'automatic-run-one',
      },
    ]);
  });

  it('uses restrained retry delays', () => {
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(5 * 60_000);
    expect(retryDelayMs(99)).toBe(30 * 60_000);
  });
});

class RepositoryStub implements AutomaticDailyRecapCollectionRepository {
  public readonly failed: {
    failureSummary: string;
    guildId: string;
    nextAttemptAt: Date;
    recapRunId: string;
  }[] = [];
  public readonly finalized: FinalizeAutomaticDailyRecapRunRequest[] = [];

  public constructor(private readonly run: ClaimedAutomaticDailyRecapRun | undefined) {}

  public claimDueRun(): Promise<ClaimedAutomaticDailyRecapRun | undefined> {
    return Promise.resolve(this.run);
  }

  public failRun(
    guildId: string,
    recapRunId: string,
    failureSummary: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    this.failed.push({ failureSummary, guildId, nextAttemptAt, recapRunId });
    return Promise.resolve();
  }

  public finalizeRun(request: FinalizeAutomaticDailyRecapRunRequest): Promise<void> {
    this.finalized.push(request);
    return Promise.resolve();
  }
}

class CollectorStub {
  public constructor(private readonly result: DailyRecapCollectionResult) {}

  public collect(): Promise<DailyRecapCollectionResult> {
    return Promise.resolve(this.result);
  }
}

class ThrowingCollector {
  public collect(): Promise<DailyRecapCollectionResult> {
    return Promise.reject(new Error('Hiscores crashed.'));
  }
}

function claimedRun(): ClaimedAutomaticDailyRecapRun {
  return {
    collectionAttemptCount: 1,
    guildId: 'guild-one',
    recapChannelId: 'recap-channel',
    recapRunId: 'automatic-run-one',
  };
}

function collection(): DailyRecapCollectionResult {
  const account: TrackedAccount = {
    accountMode: 'main',
    association: { discordUserId: 'member-one', type: 'linked' },
    createdAt: new Date('2026-08-04T00:00:00.000Z'),
    displayUsername: 'Rune Scape',
    guildId: 'guild-one',
    id: 'account-one',
    isDefault: true,
    normalizedUsername: 'rune scape',
    quotaOwnerDiscordUserId: 'member-one',
    registeredByDiscordUserId: 'member-one',
  };
  return {
    completedAt: new Date('2026-08-05T12:01:00.000Z'),
    guildId: 'guild-one',
    outcomes: [
      {
        account,
        candidateBaseline: {
          bossKillCounts: { Zulrah: 15 },
          capturedAt: new Date('2026-08-05T12:00:00.000Z'),
          skillExperience: { Attack: 200 },
          skillLevels: { Attack: 11 },
        },
        changes: { bosses: [{ boss: 'Zulrah', killCountGained: 3 }], skills: [] },
        kind: 'success',
        previousBaselineCapturedAt: new Date('2026-08-04T12:00:00.000Z'),
      },
    ],
    startedAt: new Date('2026-08-05T12:00:00.000Z'),
  };
}
