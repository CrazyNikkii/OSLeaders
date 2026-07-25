import { describe, expect, it } from 'vitest';

import {
  AccountRetrievalService,
  type AccountRetrievalRepository,
} from '../src/features/accounts/account-retrieval.js';
import {
  DefaultAccountSelectionService,
  type DefaultAccountSelectionRepository,
} from '../src/features/accounts/select-default-account.js';
import type { TrackedAccount } from '../src/features/accounts/register-account.js';

describe('account retrieval service', () => {
  it('delegates guild-scoped account queries to its repository', async () => {
    const repository = new RecordingRepository([account({ id: 'account-one' })]);
    const service = new AccountRetrievalService(repository);

    await expect(service.getById('guild-one', 'account-one')).resolves.toMatchObject({
      id: 'account-one',
    });
    await expect(service.getDefaultForMember('guild-one', 'member-one')).resolves.toMatchObject({
      id: 'account-one',
    });
    await expect(service.listForGuild('guild-one')).resolves.toHaveLength(1);
    await expect(service.listLinkedForMember('guild-one', 'member-one')).resolves.toHaveLength(1);
  });
});

describe('default account selection service', () => {
  it('allows a member to select one of their linked accounts', async () => {
    const repository = new RecordingRepository([account({ id: 'account-two', isDefault: false })]);
    const service = new DefaultAccountSelectionService(repository, repository);

    await expect(
      service.select({
        accountId: 'account-two',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toMatchObject({ kind: 'selected', account: { id: 'account-two', isDefault: true } });
  });

  it('rejects a normal member selecting somebody else’s linked account', async () => {
    const repository = new RecordingRepository([
      account({
        association: { type: 'linked', discordUserId: 'member-two' },
        id: 'account-two',
      }),
    ]);
    const service = new DefaultAccountSelectionService(repository, repository);

    await expect(
      service.select({
        accountId: 'account-two',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    expect(repository.selected).toEqual([]);
  });

  it('allows an account manager to select another member’s linked account', async () => {
    const repository = new RecordingRepository([
      account({
        association: { type: 'linked', discordUserId: 'member-two' },
        id: 'account-two',
      }),
    ]);
    const service = new DefaultAccountSelectionService(repository, repository);

    await expect(
      service.select({
        accountId: 'account-two',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
      }),
    ).resolves.toMatchObject({ kind: 'selected', account: { id: 'account-two' } });
  });

  it('does not allow watchlist or cross-guild accounts to become defaults', async () => {
    const repository = new RecordingRepository([
      account({ association: { type: 'watchlist' }, id: 'watchlist-one' }),
      account({ guildId: 'guild-two', id: 'account-two' }),
    ]);
    const service = new DefaultAccountSelectionService(repository, repository);

    await expect(
      service.select({
        accountId: 'watchlist-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toEqual({ kind: 'account_not_found' });
    await expect(
      service.select({
        accountId: 'account-two',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
      }),
    ).resolves.toEqual({ kind: 'account_not_found' });
  });
});

class RecordingRepository implements AccountRetrievalRepository, DefaultAccountSelectionRepository {
  public readonly selected: { accountId: string; discordUserId: string; guildId: string }[] = [];

  public constructor(private readonly accounts: TrackedAccount[]) {}

  public getById(guildId: string, accountId: string): Promise<TrackedAccount | undefined> {
    return Promise.resolve(
      this.accounts.find((account) => account.guildId === guildId && account.id === accountId),
    );
  }

  public getDefaultForMember(
    guildId: string,
    discordUserId: string,
  ): Promise<TrackedAccount | undefined> {
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

  public listForGuild(guildId: string): Promise<TrackedAccount[]> {
    return Promise.resolve(this.accounts.filter((account) => account.guildId === guildId));
  }

  public listLinkedForMember(guildId: string, discordUserId: string): Promise<TrackedAccount[]> {
    return Promise.resolve(
      this.accounts.filter(
        (account) =>
          account.guildId === guildId &&
          account.association.type === 'linked' &&
          account.association.discordUserId === discordUserId,
      ),
    );
  }

  public async selectDefault(
    guildId: string,
    discordUserId: string,
    accountId: string,
  ): Promise<TrackedAccount | undefined> {
    const selected = await this.getById(guildId, accountId);
    if (selected?.association.type !== 'linked') {
      return undefined;
    }
    if (selected.association.discordUserId !== discordUserId) {
      return undefined;
    }
    this.selected.push({ accountId, discordUserId, guildId });
    for (const account of this.accounts) {
      if (
        account.guildId === guildId &&
        account.association.type === 'linked' &&
        account.association.discordUserId === discordUserId
      ) {
        account.isDefault = account.id === accountId;
      }
    }
    return selected;
  }
}

function account(overrides: Partial<TrackedAccount> = {}): TrackedAccount {
  return {
    accountMode: 'main',
    association: { type: 'linked', discordUserId: 'member-one' },
    createdAt: new Date('2026-07-25T00:00:00.000Z'),
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
