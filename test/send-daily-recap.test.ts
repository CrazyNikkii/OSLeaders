import { describe, expect, it } from 'vitest';

import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import type { DailyRecapCollectionResult } from '../src/features/recaps/daily-recap-collection.js';
import type { DailyRecapFailureReporter } from '../src/features/recaps/report-daily-recap-failures.js';
import {
  ManualDailyRecapSendService,
  renderDailyRecapDeliveryContent,
  type FinalizeManualDailyRecapRunRequest,
  type ManualDailyRecapSendRepository,
  type StartManualDailyRecapRunResult,
} from '../src/features/recaps/send-daily-recap.js';

describe('manual daily recap send service', () => {
  it('creates a durable pending delivery and advances only complete successful baselines', async () => {
    const repository = new RepositoryStub({
      kind: 'started',
      run: { recapChannelId: 'recap-channel', recapRunId: 'run-one' },
    });
    const collection = recapCollection();
    const service = new ManualDailyRecapSendService(
      repository,
      new CollectorStub(collection),
      () => 'run-one',
    );

    await expect(service.send('guild-one')).resolves.toMatchObject({
      kind: 'ready_for_delivery',
      recapChannelId: 'recap-channel',
      recapRunId: 'run-one',
    });
    expect(repository.started).toEqual([{ guildId: 'guild-one', recapRunId: 'run-one' }]);
    expect(repository.finalized).toEqual([
      expect.objectContaining({
        guildId: 'guild-one',
        recapChannelId: 'recap-channel',
        recapRunId: 'run-one',
        collection,
      }),
    ]);
    expect(repository.finalized[0]?.deliveryContent).toContain('• Zulrah: +3 KC');
    expect(repository.finalized[0]?.deliveryContent).toContain('**Rune Scape · Main**');
    expect(repository.finalized[0]?.deliveryContent).toContain('Since <t:1785405600:R>');
    expect(repository.finalized[0]?.deliveryContent).toContain('Unavailable accounts');
    expect(repository.finalized[0]?.deliveryContent).toContain('Hiscores timed out');
    expect(repository.failed).toEqual([]);
  });

  it('does not collect when a recap channel is not configured or another recap is active', async () => {
    for (const result of [
      { kind: 'recap_not_configured' } as const,
      { kind: 'recap_already_running' } as const,
    ]) {
      const repository = new RepositoryStub(result);
      const collector = new CollectorStub(recapCollection());
      const service = new ManualDailyRecapSendService(repository, collector, () => 'run-one');

      await expect(service.send('guild-one')).resolves.toEqual(result);
      expect(collector.guildIds).toEqual([]);
      expect(repository.finalized).toEqual([]);
    }
  });

  it('reports per-account failures after durable finalization without failing the manual recap', async () => {
    const repository = new RepositoryStub({
      kind: 'started',
      run: { recapChannelId: 'recap-channel', recapRunId: 'run-one' },
    });
    const reporter = new RecordingFailureReporter(repository);
    const service = new ManualDailyRecapSendService(
      repository,
      new CollectorStub(recapCollection()),
      () => 'run-one',
      reporter,
    );

    await expect(service.send('guild-one')).resolves.toMatchObject({ kind: 'ready_for_delivery' });
    expect(reporter.collections).toHaveLength(1);
    expect(reporter.finalizedBeforeReport).toBe(true);
  });

  it('updates successful baselines for XP gains hidden by the recap display threshold', async () => {
    const repository = new RepositoryStub({
      kind: 'started',
      run: { recapChannelId: 'recap-channel', recapRunId: 'run-one' },
    });
    const collection = recapCollection();
    const visibleOutcome = collection.outcomes[0];
    if (visibleOutcome?.kind !== 'success') {
      throw new Error('Expected a successful recap collection outcome.');
    }
    const hiddenGainCollection = {
      ...collection,
      outcomes: [
        {
          ...visibleOutcome,
          changes: {
            bosses: [],
            skills: [
              { currentLevel: 11, experienceGained: 9_999, levelGained: 0, skill: 'Attack' },
            ],
          },
        },
      ],
    };
    const service = new ManualDailyRecapSendService(
      repository,
      new CollectorStub(hiddenGainCollection),
      () => 'run-one',
    );

    await service.send('guild-one');

    expect(repository.finalized[0]?.collection).toBe(hiddenGainCollection);
    expect(repository.finalized[0]?.deliveryContent).toContain('No notable activity today.');
    expect(repository.finalized[0]?.deliveryContent).not.toContain('Attack');
  });

  it('marks a claimed run failed without changing baselines when collection throws', async () => {
    const repository = new RepositoryStub({
      kind: 'started',
      run: { recapChannelId: 'recap-channel', recapRunId: 'run-one' },
    });
    const service = new ManualDailyRecapSendService(
      repository,
      new ThrowingCollector(),
      () => 'run-one',
    );

    await expect(service.send('guild-one')).rejects.toThrow('Hiscores crashed.');
    expect(repository.finalized).toEqual([]);
    expect(repository.failed).toEqual([
      { failureSummary: 'Hiscores crashed.', guildId: 'guild-one', recapRunId: 'run-one' },
    ]);
  });

  it('rejects a collection or outcome from another guild before finalization', async () => {
    const cases = [
      {
        collection: { ...recapCollection(), guildId: 'guild-two' },
        message: 'belongs to a different guild',
      },
      {
        collection: {
          ...recapCollection(),
          outcomes: [
            {
              ...recapCollection().outcomes[0]!,
              account: { ...trackedAccount(), guildId: 'guild-two' },
            },
          ],
        },
        message: 'contains an account from a different guild',
      },
    ];
    for (const { collection, message } of cases) {
      const repository = new RepositoryStub({
        kind: 'started',
        run: { recapChannelId: 'recap-channel', recapRunId: 'run-one' },
      });
      const service = new ManualDailyRecapSendService(
        repository,
        new CollectorStub(collection),
        () => 'run-one',
      );

      await expect(service.send('guild-one')).rejects.toThrow(message);
      expect(repository.finalized).toEqual([]);
      expect(repository.failed).toHaveLength(1);
    }
  });

  it('renders activity, no-activity, and failure sections into the durable delivery payload', () => {
    expect(
      renderDailyRecapDeliveryContent({
        failures: [{ account: trackedAccount(), failure: { kind: 'timeout' } }],
        linkedMembers: [],
        noActivity: true,
        watchlistAccounts: [],
      }),
    ).toBe(
      '**Activity**\nNo notable activity today.\n**Unavailable accounts**\n**Rune Scape** (Main) — Hiscores timed out',
    );
  });
});

class RepositoryStub implements ManualDailyRecapSendRepository {
  public readonly failed: { failureSummary: string; guildId: string; recapRunId: string }[] = [];
  public readonly finalized: FinalizeManualDailyRecapRunRequest[] = [];
  public readonly started: { guildId: string; recapRunId: string }[] = [];

  public constructor(private readonly startResult: StartManualDailyRecapRunResult) {}

  public finalizeManualRun(request: FinalizeManualDailyRecapRunRequest): Promise<void> {
    this.finalized.push(request);
    return Promise.resolve();
  }

  public failManualRun(guildId: string, recapRunId: string, failureSummary: string): Promise<void> {
    this.failed.push({ failureSummary, guildId, recapRunId });
    return Promise.resolve();
  }

  public startManualRun(
    guildId: string,
    recapRunId: string,
  ): Promise<StartManualDailyRecapRunResult> {
    this.started.push({ guildId, recapRunId });
    return Promise.resolve(this.startResult);
  }
}

class CollectorStub {
  public readonly guildIds: string[] = [];

  public constructor(private readonly collection: DailyRecapCollectionResult) {}

  public collect(guildId: string): Promise<DailyRecapCollectionResult> {
    this.guildIds.push(guildId);
    return Promise.resolve(this.collection);
  }
}

class ThrowingCollector {
  public collect(): Promise<DailyRecapCollectionResult> {
    return Promise.reject(new Error('Hiscores crashed.'));
  }
}

class RecordingFailureReporter implements DailyRecapFailureReporter {
  public readonly collections: DailyRecapCollectionResult[] = [];
  public finalizedBeforeReport = false;

  public constructor(private readonly repository: RepositoryStub) {}

  public report(collection: DailyRecapCollectionResult): Promise<void> {
    this.finalizedBeforeReport = this.repository.finalized.length === 1;
    this.collections.push(collection);
    return Promise.resolve();
  }
}

function recapCollection(): DailyRecapCollectionResult {
  const account = trackedAccount();
  return {
    completedAt: new Date('2026-07-31T10:10:00.000Z'),
    guildId: 'guild-one',
    outcomes: [
      {
        account,
        candidateBaseline: {
          bossKillCounts: { Zulrah: 15 },
          capturedAt: new Date('2026-07-31T10:05:00.000Z'),
          skillExperience: { Attack: 200 },
          skillLevels: { Attack: 11 },
        },
        changes: { bosses: [{ boss: 'Zulrah', killCountGained: 3 }], skills: [] },
        kind: 'success',
        previousBaselineCapturedAt: new Date('2026-07-30T10:00:00.000Z'),
      },
      {
        account: { ...account, id: 'failed-account' },
        failure: { kind: 'timeout' },
        kind: 'failure',
      },
    ],
    startedAt: new Date('2026-07-31T10:00:00.000Z'),
  };
}

function trackedAccount(): TrackedAccount {
  return {
    accountMode: 'main',
    association: { discordUserId: 'member-one', type: 'linked' },
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    displayUsername: 'Rune Scape',
    guildId: 'guild-one',
    id: 'account-one',
    isDefault: true,
    normalizedUsername: 'rune scape',
    quotaOwnerDiscordUserId: 'member-one',
    registeredByDiscordUserId: 'member-one',
  };
}
