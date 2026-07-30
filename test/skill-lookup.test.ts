import { describe, expect, it } from 'vitest';

import type { AccountRetrievalRepository } from '../src/features/accounts/account-retrieval.js';
import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import {
  SkillLookupService,
  type SkillLookupHiscoreFetcher,
  type SkillLookupHiscoreResult,
  type SkillLookupRequest,
} from '../src/features/lookups/skill-lookup.js';
import type { HiscoreParseResult } from '../src/infrastructure/hiscores/hiscore-result.js';
import type { OsrsHiscoreEndpoint } from '../src/infrastructure/hiscores/osrs-hiscore-catalog.js';

describe('skill lookup service', () => {
  it('fetches a caller default account with its stored mode', async () => {
    const account = trackedAccount();
    const accounts = new AccountRepositoryStub([account]);
    const hiscores = new HiscoreStub(success());
    const service = new SkillLookupService(accounts, hiscores);

    await expect(service.lookup(request())).resolves.toMatchObject({
      kind: 'found',
      skill: { experience: 13_034_431, level: 99, name: 'Strength' },
      target: { account: { id: 'account-one' }, kind: 'tracked_account' },
    });
    expect(hiscores.requests).toEqual([
      { endpoint: 'hiscore_oldschool_ironman', username: 'Rune Scape' },
    ]);
  });

  it('resolves an explicit tracked account only within the current guild', async () => {
    const accounts = new AccountRepositoryStub([
      trackedAccount({ id: 'account-one' }),
      trackedAccount({ guildId: 'guild-two', id: 'account-two' }),
    ]);
    const hiscores = new HiscoreStub(success());
    const service = new SkillLookupService(accounts, hiscores);

    await expect(
      service.lookup(request({ target: { accountId: 'account-one', kind: 'tracked_account' } })),
    ).resolves.toMatchObject({ kind: 'found', target: { account: { id: 'account-one' } } });
    await expect(
      service.lookup(request({ target: { accountId: 'account-two', kind: 'tracked_account' } })),
    ).resolves.toEqual({ kind: 'account_not_found' });
    expect(hiscores.requests).toHaveLength(1);
  });

  it('fetches a one-time account without reading or persisting a tracked account', async () => {
    const accounts = new AccountRepositoryStub([]);
    const hiscores = new HiscoreStub(success());
    const service = new SkillLookupService(accounts, hiscores);

    await expect(
      service.lookup(
        request({
          target: {
            accountMode: 'hardcore_ironman',
            kind: 'one_time_account',
            username: 'Unregistered Player',
          },
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'found',
      target: {
        accountMode: 'hardcore_ironman',
        displayUsername: 'Rune Scape',
        kind: 'one_time_account',
      },
    });
    expect(accounts.getByIdRequests).toEqual([]);
    expect(accounts.defaultRequests).toEqual([]);
    expect(hiscores.requests).toEqual([
      { endpoint: 'hiscore_oldschool_hardcore_ironman', username: 'Unregistered Player' },
    ]);
  });

  it('reports a missing default account without fetching Hiscores', async () => {
    const accounts = new AccountRepositoryStub([]);
    const hiscores = new HiscoreStub(success());
    const service = new SkillLookupService(accounts, hiscores);

    await expect(service.lookup(request())).resolves.toEqual({ kind: 'default_account_not_found' });
    expect(hiscores.requests).toEqual([]);
  });

  it('keeps the resolved target when a Hiscores request fails', async () => {
    const service = new SkillLookupService(
      new AccountRepositoryStub([trackedAccount()]),
      new HiscoreStub({ kind: 'timeout' }),
    );

    await expect(service.lookup(request())).resolves.toMatchObject({
      failure: { kind: 'timeout' },
      kind: 'hiscores_failure',
      target: { account: { id: 'account-one' }, kind: 'tracked_account' },
    });
  });

  it('uses only the Ironman endpoint instead of supplementary mode-validation fetches', async () => {
    const hiscores = new HiscoreStub(success());
    const service = new SkillLookupService(new AccountRepositoryStub([trackedAccount()]), hiscores);

    await expect(service.lookup(request())).resolves.toMatchObject({ kind: 'found' });
    expect(hiscores.requests).toEqual([
      { endpoint: 'hiscore_oldschool_ironman', username: 'Rune Scape' },
    ]);
  });

  it('reports an incomplete response when the requested skill is missing', async () => {
    const service = new SkillLookupService(
      new AccountRepositoryStub([trackedAccount()]),
      new HiscoreStub(success({ skills: [] })),
    );

    await expect(service.lookup(request())).resolves.toMatchObject({
      failure: { kind: 'incomplete_response', missing: ['Strength'] },
      kind: 'hiscores_failure',
      target: { account: { id: 'account-one' }, kind: 'tracked_account' },
    });
  });
});

class AccountRepositoryStub implements Pick<
  AccountRetrievalRepository,
  'getById' | 'getDefaultForMember'
> {
  public readonly defaultRequests: { discordUserId: string; guildId: string }[] = [];
  public readonly getByIdRequests: { accountId: string; guildId: string }[] = [];

  public constructor(private readonly accounts: readonly TrackedAccount[]) {}

  public getById(guildId: string, accountId: string): Promise<TrackedAccount | undefined> {
    this.getByIdRequests.push({ accountId, guildId });
    return Promise.resolve(
      this.accounts.find((account) => account.guildId === guildId && account.id === accountId),
    );
  }

  public getDefaultForMember(
    guildId: string,
    discordUserId: string,
  ): Promise<TrackedAccount | undefined> {
    this.defaultRequests.push({ discordUserId, guildId });
    return Promise.resolve(
      this.accounts.find(
        (account) =>
          account.guildId === guildId &&
          account.isDefault &&
          account.association.type === 'linked' &&
          account.association.discordUserId === discordUserId,
      ),
    );
  }
}

class HiscoreStub implements SkillLookupHiscoreFetcher {
  public readonly requests: { endpoint: OsrsHiscoreEndpoint; username: string }[] = [];

  public constructor(private readonly result: SkillLookupHiscoreResult) {}

  public fetchHiscores(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
  ): Promise<SkillLookupHiscoreResult> {
    this.requests.push({ endpoint, username });
    return Promise.resolve(this.result);
  }
}

function request(overrides: Partial<SkillLookupRequest> = {}): SkillLookupRequest {
  return {
    guildId: 'guild-one',
    requesterDiscordUserId: 'member-one',
    skill: 'Strength',
    target: { kind: 'default_account' },
    ...overrides,
  };
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
  overrides: Partial<Extract<HiscoreParseResult, { kind: 'success' }>['data']> = {},
): Extract<HiscoreParseResult, { kind: 'success' }> {
  return {
    data: {
      activities: [],
      bosses: [],
      returnedName: 'Rune Scape',
      skills: [{ experience: 13_034_431, id: 2, level: 99, name: 'Strength', rank: 42 }],
      ...overrides,
    },
    kind: 'success',
  };
}
