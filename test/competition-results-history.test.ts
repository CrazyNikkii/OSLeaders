import { describe, expect, it } from 'vitest';

import {
  CompetitionResultsHistoryService,
  type CompetitionResultsHistoryRepository,
  type FinishedCompetitionRecord,
} from '../src/features/competitions/competition-results-history.js';

describe('competition results history service', () => {
  it('combines immutable account gains, ranks exact ties, and marks all winners', async () => {
    const service = new CompetitionResultsHistoryService(new Repository());

    await expect(
      service.getFinishedResult({ competitionId: 'competition-one', guildId: 'guild-one' }),
    ).resolves.toMatchObject({
      kind: 'finished_result',
      entries: [
        { entrantId: 'entrant-one', finalGain: 60n, isWinner: true, rank: 1 },
        { entrantId: 'entrant-watchlist', finalGain: 60n, isWinner: true, rank: 1 },
      ],
    });
  });

  it('does not turn a missing final account value into a fabricated rank', async () => {
    const service = new CompetitionResultsHistoryService(
      new Repository({
        ...record(),
        accounts: [
          ...record().accounts,
          {
            accountMode: 'main',
            displayUsername: 'Unavailable',
            discordUserId: 'member-two',
            entrantId: 'entrant-two',
            finalValue: null,
            id: 'account-unavailable',
            startingValue: 100n,
          },
        ],
        winners: [{ entrantId: 'entrant-one', finalGain: 60n }],
      }),
    );

    const result = await service.getFinishedResult({
      competitionId: 'competition-one',
      guildId: 'guild-one',
    });
    if (result.kind !== 'finished_result') throw new Error('Expected finished result.');
    expect(result.entries.find((entry) => entry.entrantId === 'entrant-two')).toMatchObject({
      finalGain: null,
      isWinner: false,
      rank: null,
    });
  });

  it('keeps result retrieval guild-scoped', async () => {
    const service = new CompetitionResultsHistoryService(new Repository());
    await expect(
      service.getFinishedResult({ competitionId: 'competition-one', guildId: 'guild-two' }),
    ).resolves.toEqual({ kind: 'competition_not_found' });
  });
});

class Repository implements CompetitionResultsHistoryRepository {
  public constructor(private readonly result: FinishedCompetitionRecord = record()) {}

  public findFinished(request: { competitionId: string; guildId: string }) {
    return Promise.resolve(
      request.guildId === 'guild-one' && request.competitionId === 'competition-one'
        ? this.result
        : { kind: 'competition_not_found' as const },
    );
  }

  public listFinished() {
    return Promise.resolve([{ displayName: 'Mining week', id: 'competition-one' }]);
  }
}

function record(): FinishedCompetitionRecord {
  return {
    accounts: [
      {
        accountMode: 'main',
        displayUsername: 'Alpha',
        discordUserId: 'member-one',
        entrantId: 'entrant-one',
        finalValue: 150n,
        id: 'account-alpha',
        startingValue: 100n,
      },
      {
        accountMode: 'ironman',
        displayUsername: 'Bravo',
        discordUserId: 'member-one',
        entrantId: 'entrant-one',
        finalValue: 55n,
        id: 'account-bravo',
        startingValue: 45n,
      },
      {
        accountMode: 'hardcore_ironman',
        displayUsername: 'Watchlist',
        discordUserId: null,
        entrantId: 'entrant-watchlist',
        finalValue: 60n,
        id: 'account-watchlist',
        startingValue: 0n,
      },
    ],
    competitionId: 'competition-one',
    displayName: 'Mining week',
    finishedAt: new Date('2026-08-10T16:00:00.000Z'),
    guildId: 'guild-one',
    isResultDelayed: true,
    metric: { kind: 'skill', name: 'Mining' },
    targetValue: null,
    winners: [
      { entrantId: 'entrant-one', finalGain: 60n },
      { entrantId: 'entrant-watchlist', finalGain: 60n },
    ],
  };
}
