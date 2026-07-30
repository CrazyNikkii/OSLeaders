import { describe, expect, it } from 'vitest';

import type { AccountRetrievalRepository } from '../src/features/accounts/account-retrieval.js';
import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import {
  BossLeaderboardService,
  type BossLeaderboardHiscoreFetcher,
  type BossLeaderboardHiscoreResult,
} from '../src/features/leaderboards/boss-leaderboard.js';
import type { HiscoreParseResult } from '../src/infrastructure/hiscores/hiscore-result.js';
import type { OsrsHiscoreEndpoint } from '../src/infrastructure/hiscores/osrs-hiscore-catalog.js';

describe('boss leaderboard service', () => {
  it('lists only current-guild accounts, fetches each stored mode, and sorts by kill count', async () => {
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
    const service = new BossLeaderboardService(accounts, hiscores);

    await expect(
      service.getLeaderboard({ boss: 'Abyssal Sire', guildId: 'guild-one' }),
    ).resolves.toMatchObject({
      entries: [
        { account: { id: 'amy' }, boss: { score: 200 } },
        { account: { id: 'zed' }, boss: { score: 200 } },
        { account: { id: 'watchlist' }, boss: { score: 100 } },
      ],
      failures: [],
    });
    expect(accounts.guildRequests).toEqual(['guild-one']);
    expect(hiscores.requests).toEqual([
      { endpoint: 'hiscore_oldschool_ironman', username: 'Zed' },
      { endpoint: 'hiscore_oldschool_hardcore_ironman', username: 'Amy' },
      { endpoint: 'hiscore_oldschool', username: 'Watchlist' },
    ]);
  });

  it('omits zero-KC accounts when another account has KC', async () => {
    const service = new BossLeaderboardService(
      new AccountRepositoryStub([
        trackedAccount({ displayUsername: 'Active', id: 'active' }),
        trackedAccount({ displayUsername: 'Zero', id: 'zero' }),
      ]),
      new HiscoreStub({ Active: success(1), Zero: success(0) }),
    );

    await expect(
      service.getLeaderboard({ boss: 'Abyssal Sire', guildId: 'guild-one' }),
    ).resolves.toMatchObject({ entries: [{ account: { id: 'active' }, boss: { score: 1 } }] });
  });

  it('shows zero-KC accounts when every successful account has zero KC', async () => {
    const service = new BossLeaderboardService(
      new AccountRepositoryStub([
        trackedAccount({ displayUsername: 'Alpha', id: 'alpha', normalizedUsername: 'alpha' }),
        trackedAccount({ displayUsername: 'Beta', id: 'beta', normalizedUsername: 'beta' }),
      ]),
      new HiscoreStub({ Alpha: success(0), Beta: success(0) }),
    );

    await expect(
      service.getLeaderboard({ boss: 'Abyssal Sire', guildId: 'guild-one' }),
    ).resolves.toMatchObject({
      entries: [{ account: { id: 'alpha' } }, { account: { id: 'beta' } }],
    });
  });

  it('returns successful entries when other accounts fail to fetch', async () => {
    const service = new BossLeaderboardService(
      new AccountRepositoryStub([
        trackedAccount({ displayUsername: 'Available', id: 'available' }),
        trackedAccount({ displayUsername: 'Unavailable', id: 'unavailable' }),
      ]),
      new HiscoreStub({ Available: success(123), Unavailable: { kind: 'timeout' } }),
    );

    await expect(
      service.getLeaderboard({ boss: 'Abyssal Sire', guildId: 'guild-one' }),
    ).resolves.toMatchObject({
      entries: [{ account: { id: 'available' }, boss: { score: 123 } }],
      failures: [{ account: { id: 'unavailable' }, failure: { kind: 'timeout' } }],
    });
  });

  it('reports an incomplete response for an otherwise successful account missing the boss', async () => {
    const service = new BossLeaderboardService(
      new AccountRepositoryStub([trackedAccount()]),
      new HiscoreStub({ 'Rune Scape': success(50, []) }),
    );

    await expect(
      service.getLeaderboard({ boss: 'Abyssal Sire', guildId: 'guild-one' }),
    ).resolves.toMatchObject({
      entries: [],
      failures: [
        {
          account: { id: 'account-one' },
          failure: { kind: 'incomplete_response', missing: ['Abyssal Sire'] },
        },
      ],
    });
  });

  it('returns an empty leaderboard without fetching when the guild has no accounts', async () => {
    const hiscores = new HiscoreStub({});
    const service = new BossLeaderboardService(new AccountRepositoryStub([]), hiscores);

    await expect(
      service.getLeaderboard({ boss: 'Abyssal Sire', guildId: 'guild-one' }),
    ).resolves.toEqual({ boss: 'Abyssal Sire', entries: [], failures: [] });
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

class HiscoreStub implements BossLeaderboardHiscoreFetcher {
  public readonly requests: { endpoint: OsrsHiscoreEndpoint; username: string }[] = [];

  public constructor(
    private readonly results: Readonly<Record<string, BossLeaderboardHiscoreResult>>,
  ) {}

  public fetchHiscores(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
  ): Promise<BossLeaderboardHiscoreResult> {
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
  score: number,
  bosses = [{ id: 0, name: 'Abyssal Sire' as const, rank: 42, score }],
): Extract<HiscoreParseResult, { kind: 'success' }> {
  return {
    data: { activities: [], bosses, returnedName: 'Rune Scape', skills: [] },
    kind: 'success',
  };
}
