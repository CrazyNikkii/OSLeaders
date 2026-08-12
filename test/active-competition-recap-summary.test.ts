import { describe, expect, it } from 'vitest';

import {
  DailyRecapCompetitionSummaryService,
  type ActiveCompetitionRecapChoices,
  type ActiveCompetitionRecapStandings,
} from '../src/features/recaps/active-competition-recap-summary.js';

describe('daily recap active-competition summaries', () => {
  it('summarizes the top three active entrants and retains incomplete-score context', async () => {
    const choices = new ChoicesStub([{ displayName: 'Magic sprint', id: 'competition-one' }]);
    const standings = new StandingsStub({
      competitionId: 'competition-one',
      endsAt: null,
      entries: [
        entry(1, 'member-one', 500_000n),
        entry(2, null, 450_000n),
        entry(3, 'member-three', 400_000n),
        entry(4, 'member-four', 300_000n),
      ],
      failures: [{ accountId: 'account-four', failure: { kind: 'timeout' } }],
      kind: 'standings',
      metric: { kind: 'skill', name: 'Magic' },
      targetValue: null,
    });

    await expect(
      new DailyRecapCompetitionSummaryService(choices, standings).summarize('guild-one'),
    ).resolves.toEqual({
      summaries: [
        {
          displayName: 'Magic sprint',
          endsAt: null,
          entries: [
            { discordUserId: 'member-one', gain: 500_000n, rank: 1 },
            { discordUserId: null, gain: 450_000n, rank: 2 },
            { discordUserId: 'member-three', gain: 400_000n, rank: 3 },
          ],
          hasIncompleteScores: true,
          metric: { kind: 'skill', name: 'Magic' },
          targetValue: null,
        },
      ],
      unavailableCompetitionNames: [],
    });
    expect(choices.guildIds).toEqual(['guild-one']);
    expect(standings.requests).toEqual([
      { competitionId: 'competition-one', guildId: 'guild-one' },
    ]);
  });

  it('keeps one unavailable competition from hiding successful summaries', async () => {
    const choices = new ChoicesStub([
      { displayName: 'Available', id: 'available' },
      { displayName: 'Unavailable', id: 'unavailable' },
    ]);
    const standings = new StandingsStub({
      competitionId: 'available',
      endsAt: null,
      entries: [entry(1, 'member-one', 3n)],
      failures: [],
      kind: 'standings',
      metric: { kind: 'boss', name: 'Zulrah' },
      targetValue: null,
    });
    standings.errors.add('unavailable');

    await expect(
      new DailyRecapCompetitionSummaryService(choices, standings).summarize('guild-one'),
    ).resolves.toMatchObject({
      summaries: [{ displayName: 'Available' }],
      unavailableCompetitionNames: ['Unavailable'],
    });
  });

  it('treats an unavailable active-competition list as optional recap data', async () => {
    const choices = new ChoicesStub([]);
    choices.error = new Error('database unavailable');

    await expect(
      new DailyRecapCompetitionSummaryService(choices, new StandingsStub(undefined)).summarize(
        'guild-one',
      ),
    ).resolves.toEqual({ summaries: [], unavailableCompetitionNames: ['active competitions'] });
  });
});

class ChoicesStub implements ActiveCompetitionRecapChoices {
  public error: Error | undefined;
  public readonly guildIds: string[] = [];

  public constructor(
    private readonly competitions: readonly { displayName: string; id: string }[],
  ) {}

  public listActive(guildId: string): Promise<readonly { displayName: string; id: string }[]> {
    this.guildIds.push(guildId);
    return this.error === undefined
      ? Promise.resolve(this.competitions)
      : Promise.reject(this.error);
  }
}

class StandingsStub implements ActiveCompetitionRecapStandings {
  public readonly errors = new Set<string>();
  public readonly requests: { competitionId: string; guildId: string }[] = [];

  public constructor(
    private readonly result:
      Awaited<ReturnType<ActiveCompetitionRecapStandings['getStandings']>> | undefined,
  ) {}

  public getStandings(request: { competitionId: string; guildId: string }) {
    this.requests.push(request);
    if (this.errors.has(request.competitionId))
      return Promise.reject(new Error('Hiscores unavailable'));
    if (this.result === undefined)
      return Promise.resolve({ kind: 'competition_not_found' as const });
    return Promise.resolve({ ...this.result, competitionId: request.competitionId });
  }
}

function entry(rank: number, discordUserId: string | null, gain: bigint) {
  return {
    accounts: [],
    discordUserId,
    entrantId: `entrant-${rank}`,
    gain,
    isPotentiallyIncomplete: false,
    rank,
  };
}
