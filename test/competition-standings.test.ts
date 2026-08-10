import { describe, expect, it } from 'vitest';

import {
  CompetitionStandingsService,
  type ActiveCompetitionForStandings,
  type CompetitionStandingsHiscoreFetcher,
  type CompetitionStandingsRepository,
} from '../src/features/competitions/competition-standings.js';
import type { OsrsHiscoreEndpoint } from '../src/infrastructure/hiscores/osrs-hiscore-catalog.js';

describe('competition standings service', () => {
  it('sums linked accounts, keeps watchlists standalone, and shares tied ranks', async () => {
    const repository = new Repository();
    const service = new CompetitionStandingsService(
      repository,
      new Hiscores({ Alpha: success(150), Bravo: success(55), Watchlist: success(60) }),
      () => new Date('2026-08-10T13:00:00.000Z'),
    );

    await expect(service.getStandings(request())).resolves.toMatchObject({
      kind: 'standings',
      entries: [
        { entrantId: 'entrant-one', gain: 60n, rank: 1, isPotentiallyIncomplete: false },
        { entrantId: 'entrant-watchlist', gain: 60n, rank: 1, isPotentiallyIncomplete: false },
      ],
    });
    expect(repository.recorded[0]).toMatchObject({
      values: [
        { accountId: 'account-alpha', value: 150n },
        { accountId: 'account-bravo', value: 55n },
        { accountId: 'account-watchlist', value: 60n },
      ],
    });
  });

  it('uses a failed account’s retained value and marks only its entrant incomplete', async () => {
    const repository = new Repository();
    const service = new CompetitionStandingsService(
      repository,
      new Hiscores({ Alpha: { kind: 'timeout' }, Bravo: success(80), Watchlist: success(0) }),
    );

    await expect(service.getStandings(request())).resolves.toMatchObject({
      kind: 'standings',
      entries: [
        {
          entrantId: 'entrant-one',
          gain: 75n,
          isPotentiallyIncomplete: true,
          accounts: [
            { id: 'account-alpha', currentValue: 140n, gain: 40n, isCurrentValueStale: true },
            { id: 'account-bravo', currentValue: 80n, gain: 35n, isCurrentValueStale: false },
          ],
        },
        { entrantId: 'entrant-watchlist', gain: 0n, isPotentiallyIncomplete: false },
      ],
      failures: [{ accountId: 'account-alpha', failure: { kind: 'timeout' } }],
    });
    expect(repository.recorded[0]?.values).toEqual([
      { accountId: 'account-bravo', value: 80n },
      { accountId: 'account-watchlist', value: 0n },
    ]);
  });

  it('does not fetch outside the requested active competition', async () => {
    const hiscores = new Hiscores({});
    const service = new CompetitionStandingsService(
      new Repository({ kind: 'not_active' }),
      hiscores,
    );

    await expect(service.getStandings(request())).resolves.toEqual({ kind: 'not_active' });
    await expect(service.getStandings(request({ guildId: 'other-guild' }))).resolves.toEqual({
      kind: 'competition_not_found',
    });
    expect(hiscores.usernames).toEqual([]);
  });

  it('uses boss KC and normalizes an unranked score to zero', async () => {
    const repository = new Repository({
      ...competition(),
      accounts: [account('account-boss', 'Boss Player', 'entrant-boss', 5n, 5n)],
      metric: { kind: 'boss', name: 'Maggot King' },
    });
    const service = new CompetitionStandingsService(
      repository,
      new Hiscores({ 'Boss Player': bossSuccess(-1) }),
    );

    await expect(service.getStandings(request())).resolves.toMatchObject({
      entries: [{ entrantId: 'entrant-boss', gain: 0n, accounts: [{ currentValue: 0n }] }],
      kind: 'standings',
    });
  });
});

class Repository implements CompetitionStandingsRepository {
  public readonly recorded: { values: readonly { accountId: string; value: bigint }[] }[] = [];
  public constructor(
    private readonly result: ActiveCompetitionForStandings | { kind: 'not_active' } = competition(),
  ) {}
  public findActive(request: { guildId: string }) {
    return Promise.resolve(
      request.guildId === 'guild-one' ? this.result : { kind: 'competition_not_found' as const },
    );
  }
  public recordObservedValues(request: {
    values: readonly { accountId: string; value: bigint }[];
  }) {
    this.recorded.push(request);
    return Promise.resolve();
  }
}

class Hiscores implements CompetitionStandingsHiscoreFetcher {
  public readonly usernames: string[] = [];
  public constructor(
    private readonly responses: Record<
      string,
      ReturnType<typeof success> | ReturnType<typeof bossSuccess> | { kind: 'timeout' }
    >,
  ) {}
  public fetchHiscores(_endpoint: OsrsHiscoreEndpoint, username: string) {
    this.usernames.push(username);
    return Promise.resolve(this.responses[username]!);
  }
}

function competition(): ActiveCompetitionForStandings {
  return {
    accounts: [
      account('account-alpha', 'Alpha', 'entrant-one', 100n, 140n),
      account('account-bravo', 'Bravo', 'entrant-one', 45n, 45n),
      account('account-watchlist', 'Watchlist', 'entrant-watchlist', 0n, 0n),
    ],
    competitionId: 'competition-one',
    endsAt: null,
    guildId: 'guild-one',
    metric: { kind: 'skill', name: 'Woodcutting' },
    targetValue: null,
  };
}
function account(
  id: string,
  displayUsername: string,
  entrantId: string,
  startingValue: bigint,
  lastKnownValue: bigint,
) {
  return {
    accountMode: 'main' as const,
    displayUsername,
    entrantDiscordUserId: entrantId === 'entrant-one' ? 'member-one' : null,
    entrantId,
    id,
    lastKnownValue,
    startingValue,
  };
}
function success(experience: number) {
  return {
    kind: 'success' as const,
    data: {
      activities: [],
      bosses: [],
      returnedName: 'Player',
      skills: [{ id: 8, level: 1, name: 'Woodcutting' as const, experience, rank: 1 }],
    },
  };
}
function bossSuccess(score: number) {
  return {
    kind: 'success' as const,
    data: {
      activities: [],
      bosses: [{ id: 35, name: 'Maggot King' as const, rank: -1, score }],
      returnedName: 'Player',
      skills: [],
    },
  };
}
function request(overrides: Partial<{ guildId: string }> = {}) {
  return { competitionId: 'competition-one', guildId: 'guild-one', ...overrides };
}
