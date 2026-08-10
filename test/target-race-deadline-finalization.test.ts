import { describe, expect, it } from 'vitest';

import {
  TargetRaceDeadlineFinalizationService,
  type TargetRaceDeadlineFinalizationRepository,
} from '../src/features/competitions/finalize-target-race-deadline.js';

describe('target-race deadline finalization', () => {
  it('bypasses the cache and persists every final value for shared winners', async () => {
    const repository = new Finals();
    const service = new TargetRaceDeadlineFinalizationService(
      repository,
      {
        fetchHiscores: (_endpoint, username) =>
          Promise.resolve({
            kind: 'success' as const,
            data: {
              activities: [],
              bosses: [],
              returnedName: username,
              skills: [
                {
                  experience: username === 'one' ? 150 : 250,
                  id: 0,
                  level: 1,
                  name: 'Attack',
                  rank: 1,
                },
              ],
            },
          }),
      },
      () => new Date('2026-08-10T12:00:00.000Z'),
    );

    await expect(service.finalizeDue()).resolves.toMatchObject({
      kind: 'finished',
      winnerEntrantIds: ['entrant-one', 'entrant-two'],
    });
    expect(repository.completed[0]?.finalValues).toEqual([
      { accountId: 'account-one', entrantId: 'entrant-one', value: 150n },
      { accountId: 'account-two', entrantId: 'entrant-two', value: 250n },
    ]);
  });

  it('schedules a durable retry when any final fetch fails', async () => {
    const repository = new Finals();
    let fetchCount = 0;
    const reports: object[] = [];
    const service = new TargetRaceDeadlineFinalizationService(
      repository,
      {
        fetchHiscores: () => {
          fetchCount += 1;
          return Promise.resolve({ kind: 'timeout' as const });
        },
      },
      undefined,
      {
        report: (_guildId, failures) => {
          reports.push(failures);
          return Promise.resolve();
        },
      },
    );

    await expect(service.finalizeDue()).resolves.toMatchObject({ kind: 'finish_pending' });
    expect(fetchCount).toBe(4);
    expect(reports).toHaveLength(1);
    expect(repository.retries).toHaveLength(1);
    expect(repository.completed).toEqual([]);
  });
});

class Finals implements TargetRaceDeadlineFinalizationRepository {
  public readonly completed: Parameters<
    TargetRaceDeadlineFinalizationRepository['completeFinalization']
  >[0][] = [];
  public readonly retries: Parameters<
    TargetRaceDeadlineFinalizationRepository['scheduleRetry']
  >[0][] = [];

  public claimDueFinalization() {
    return Promise.resolve({
      accounts: [
        {
          accountMode: 'main' as const,
          competitionEntrantId: 'entrant-one',
          displayUsername: 'one',
          id: 'account-one',
          startingValue: 100n,
        },
        {
          accountMode: 'main' as const,
          competitionEntrantId: 'entrant-two',
          displayUsername: 'two',
          id: 'account-two',
          startingValue: 200n,
        },
      ],
      competitionId: 'competition-one',
      finishAttemptCount: 1,
      guildId: 'guild-one',
      metric: { kind: 'skill' as const, name: 'Attack' },
    });
  }

  public completeFinalization(
    request: Parameters<TargetRaceDeadlineFinalizationRepository['completeFinalization']>[0],
  ) {
    this.completed.push(request);
    return Promise.resolve({
      kind: 'finished' as const,
      winnerEntrantIds: ['entrant-one', 'entrant-two'],
    });
  }

  public scheduleRetry(
    request: Parameters<TargetRaceDeadlineFinalizationRepository['scheduleRetry']>[0],
  ) {
    this.retries.push(request);
    return Promise.resolve();
  }
}
