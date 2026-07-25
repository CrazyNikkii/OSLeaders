import { describe, expect, it } from 'vitest';

import {
  AccountRemovalService,
  canRemoveAccount,
  type AccountRemovalRepository,
  type RemoveAccountRequest,
} from '../src/features/accounts/remove-account.js';
import type { TrackedAccount } from '../src/features/accounts/register-account.js';

describe('account removal service', () => {
  it('allows a linked-account owner and an account manager to remove an account', async () => {
    const ownerRepository = new RecordingRepository([account()]);
    const ownerService = new AccountRemovalService(ownerRepository);

    await expect(
      ownerService.remove({
        accountId: 'account-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toMatchObject({ kind: 'removed', account: { id: 'account-one' } });

    const managerRepository = new RecordingRepository([account()]);
    const managerService = new AccountRemovalService(managerRepository);
    await expect(
      managerService.remove({
        accountId: 'account-one',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
      }),
    ).resolves.toMatchObject({ kind: 'removed' });
  });

  it('allows a watchlist registrant to remove their account', async () => {
    const repository = new RecordingRepository([
      account({
        association: { type: 'watchlist' },
        id: 'watchlist-one',
        isDefault: false,
        registeredByDiscordUserId: 'adder-one',
      }),
    ]);
    const service = new AccountRemovalService(repository);

    await expect(
      service.remove({
        accountId: 'watchlist-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'adder-one',
      }),
    ).resolves.toMatchObject({ kind: 'removed' });
  });

  it('rejects unauthorized and cross-guild removals', async () => {
    const repository = new RecordingRepository([
      account(),
      account({ guildId: 'guild-two', id: 'account-two' }),
    ]);
    const service = new AccountRemovalService(repository);

    await expect(
      service.remove({
        accountId: 'account-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-two',
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    await expect(
      service.remove({
        accountId: 'account-two',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
      }),
    ).resolves.toEqual({ kind: 'account_not_found' });
    expect(repository.removals).toEqual([]);
  });
});

class RecordingRepository implements AccountRemovalRepository {
  public readonly removals: { accountId: string; guildId: string }[] = [];

  public constructor(private readonly accounts: TrackedAccount[]) {}

  public removeAccount(request: RemoveAccountRequest) {
    const index = this.accounts.findIndex(
      (account) => account.guildId === request.guildId && account.id === request.accountId,
    );
    if (index === -1) {
      return Promise.resolve({ kind: 'account_not_found' as const });
    }
    const selected = this.accounts[index];
    if (selected === undefined) {
      throw new Error('Selected account was unexpectedly absent.');
    }
    if (!canRemoveAccount(selected, request)) {
      return Promise.resolve({ kind: 'forbidden' as const });
    }
    this.accounts.splice(index, 1);
    this.removals.push({ accountId: request.accountId, guildId: request.guildId });
    return Promise.resolve({ kind: 'removed' as const, account: selected });
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
