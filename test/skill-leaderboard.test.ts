import { describe, expect, it } from 'vitest';

import type { AccountRetrievalRepository } from '../src/features/accounts/account-retrieval.js';
import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import {
  SkillLeaderboardService,
  type SkillLeaderboardHiscoreFetcher,
  type SkillLeaderboardHiscoreResult,
} from '../src/features/leaderboards/skill-leaderboard.js';
import type { HiscoreParseResult } from '../src/infrastructure/hiscores/hiscore-result.js';
import type { OsrsHiscoreEndpoint } from '../src/infrastructure/hiscores/osrs-hiscore-catalog.js';

describe('skill leaderboard service', () => {
  it('lists only current-guild accounts, fetches each stored mode, and sorts by experience', async () => {
    const accounts = new AccountRepositoryStub([
      trackedAccount({ displayUsername: 'Zed', id: 'zed', normalizedUsername: 'zed' }),
      trackedAccount({
        accountMode: 'hardcore_ironman',
        displayUsername: 'Amy',
        id: 'amy',
        normalizedUsername: 'amy',
      }),
      trackedAccount({
        accountMode: 'group_ironman',
        association: { type: 'watchlist' },
        displayUsername: 'Watchlist',
        id: 'watchlist',
        normalizedUsername: 'watchlist',
      }),
    ]);
    const hiscores = new HiscoreStub({
      Amy: success(200),
      Watchlist: success(100),
      Zed: success(200),
    });
    const service = new SkillLeaderboardService(accounts, hiscores);

    await expect(
      service.getLeaderboard({ guildId: 'guild-one', skill: 'Strength' }),
    ).resolves.toMatchObject({
      entries: [
        { account: { id: 'amy' }, skill: { experience: 200 } },
        { account: { id: 'zed' }, skill: { experience: 200 } },
        { account: { id: 'watchlist' }, skill: { experience: 100 } },
      ],
      failures: [],
      skill: 'Strength',
    });
    expect(accounts.guildRequests).toEqual(['guild-one']);
    expect(hiscores.requests).toEqual([
      { endpoint: 'hiscore_oldschool_ironman', username: 'Zed' },
      { endpoint: 'hiscore_oldschool_hardcore_ironman', username: 'Amy' },
      { endpoint: 'hiscore_oldschool', username: 'Watchlist' },
    ]);
  });

  it('returns successful entries when other accounts fail to fetch', async () => {
    const service = new SkillLeaderboardService(
      new AccountRepositoryStub([
        trackedAccount({ displayUsername: 'Available', id: 'available' }),
        trackedAccount({ displayUsername: 'Unavailable', id: 'unavailable' }),
      ]),
      new HiscoreStub({ Available: success(123), Unavailable: { kind: 'timeout' } }),
    );

    await expect(
      service.getLeaderboard({ guildId: 'guild-one', skill: 'Strength' }),
    ).resolves.toMatchObject({
      entries: [{ account: { id: 'available' }, skill: { experience: 123 } }],
      failures: [{ account: { id: 'unavailable' }, failure: { kind: 'timeout' } }],
    });
  });

  it('reports an incomplete response for an otherwise successful account missing the skill', async () => {
    const service = new SkillLeaderboardService(
      new AccountRepositoryStub([trackedAccount()]),
      new HiscoreStub({ 'Rune Scape': success(50, []) }),
    );

    await expect(
      service.getLeaderboard({ guildId: 'guild-one', skill: 'Strength' }),
    ).resolves.toMatchObject({
      entries: [],
      failures: [
        {
          account: { id: 'account-one' },
          failure: { kind: 'incomplete_response', missing: ['Strength'] },
        },
      ],
    });
  });

  it('returns an empty leaderboard without fetching when the guild has no accounts', async () => {
    const hiscores = new HiscoreStub({});
    const service = new SkillLeaderboardService(new AccountRepositoryStub([]), hiscores);

    await expect(
      service.getLeaderboard({ guildId: 'guild-one', skill: 'Strength' }),
    ).resolves.toEqual({
      entries: [],
      failures: [],
      skill: 'Strength',
    });
    expect(hiscores.requests).toEqual([]);
  });
});

class AccountRepositoryStub implements Pick<AccountRetrievalRepository, 'listForGuild'> {
  public readonly guildRequests: string[] = [];

  public constructor(private readonly accounts: readonly TrackedAccount[]) {}

  public listForGuild(guildId: string): Promise<TrackedAccount[]> {
    this.guildRequests.push(guildId);
    return Promise.resolve(this.accounts.filter((account) => account.guildId === guildId));
  }
}

class HiscoreStub implements SkillLeaderboardHiscoreFetcher {
  public readonly requests: { endpoint: OsrsHiscoreEndpoint; username: string }[] = [];

  public constructor(
    private readonly results: Readonly<Record<string, SkillLeaderboardHiscoreResult>>,
  ) {}

  public fetchHiscores(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
  ): Promise<SkillLeaderboardHiscoreResult> {
    this.requests.push({ endpoint, username });
    const result = this.results[username];
    if (result === undefined) {
      throw new Error(`No Hiscores result was configured for ${username}.`);
    }
    return Promise.resolve(result);
  }
}

function trackedAccount(overrides: Partial<TrackedAccount> = {}): TrackedAccount {
  return {
    accountMode: 'ironman',
    association: { discordUserId: 'member-one', type: 'linked' },
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    displayUsername: 'Rune Scape',
    guildId: 'guild-one',
    id: 'account-one',
    isDefault: true,
    normalizedUsername: 'rune scape',
    quotaOwnerDiscordUserId: 'member-one',
    registeredByDiscordUserId: 'member-one',
    ...overrides,
  };
}

function success(
  experience: number,
  skills = [{ experience, id: 2, level: 99, name: 'Strength' as const, rank: 42 }],
): Extract<HiscoreParseResult, { kind: 'success' }> {
  return {
    data: { activities: [], bosses: [], returnedName: 'Rune Scape', skills },
    kind: 'success',
  };
}
