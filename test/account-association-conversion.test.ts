import { describe, expect, it } from 'vitest';

import {
  AccountAssociationConversionService,
  canConvertAccountAssociation,
  type AccountAssociationConversionRepository,
  type ConvertAccountAssociationRequest,
} from '../src/features/accounts/convert-account-association.js';
import type { TrackedAccount } from '../src/features/accounts/register-account.js';

describe('account association conversion service', () => {
  it('allows an account manager to link a watchlist account to a member', async () => {
    const repository = new RecordingRepository([watchlistAccount()]);
    const service = new AccountAssociationConversionService(repository);

    await expect(
      service.convert({
        accountId: 'account-one',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
        targetAssociation: { type: 'linked', discordUserId: 'member-two' },
      }),
    ).resolves.toMatchObject({
      kind: 'converted',
      account: {
        association: { type: 'linked', discordUserId: 'member-two' },
        quotaOwnerDiscordUserId: 'member-two',
      },
    });
  });

  it('allows a linked owner or account manager to return an account to the original watchlist adder', async () => {
    const repository = new RecordingRepository([
      account({ registeredByDiscordUserId: 'original-adder' }),
    ]);
    const service = new AccountAssociationConversionService(repository);

    await expect(
      service.convert({
        accountId: 'account-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        targetAssociation: { type: 'watchlist' },
      }),
    ).resolves.toMatchObject({
      kind: 'converted',
      account: {
        association: { type: 'watchlist' },
        quotaOwnerDiscordUserId: 'original-adder',
      },
    });

    const managerRepository = new RecordingRepository([
      account({ registeredByDiscordUserId: 'original-adder' }),
    ]);
    const managerService = new AccountAssociationConversionService(managerRepository);
    await expect(
      managerService.convert({
        accountId: 'account-one',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
        targetAssociation: { type: 'watchlist' },
      }),
    ).resolves.toMatchObject({
      kind: 'converted',
      account: { quotaOwnerDiscordUserId: 'original-adder' },
    });
  });

  it('rejects unauthorized, cross-guild, and unchanged-association conversions', async () => {
    const repository = new RecordingRepository([
      watchlistAccount(),
      account({ guildId: 'guild-two', id: 'account-two' }),
    ]);
    const service = new AccountAssociationConversionService(repository);

    await expect(
      service.convert({
        accountId: 'account-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        targetAssociation: { type: 'linked', discordUserId: 'member-one' },
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    await expect(
      service.convert({
        accountId: 'account-two',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
        targetAssociation: { type: 'watchlist' },
      }),
    ).resolves.toEqual({ kind: 'account_not_found' });
    await expect(
      service.convert({
        accountId: 'account-one',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
        targetAssociation: { type: 'watchlist' },
      }),
    ).resolves.toEqual({ kind: 'association_unchanged' });
    expect(repository.conversions).toEqual([]);
  });

  it('rechecks current ownership when a formerly linked member requests conversion', async () => {
    const repository = new RecordingRepository([
      account({ association: { type: 'linked', discordUserId: 'member-two' } }),
    ]);
    const service = new AccountAssociationConversionService(repository);

    await expect(
      service.convert({
        accountId: 'account-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        targetAssociation: { type: 'watchlist' },
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    expect(repository.conversions).toEqual([]);
  });
});

class RecordingRepository implements AccountAssociationConversionRepository {
  public readonly conversions: { accountId: string; guildId: string }[] = [];

  public constructor(private readonly accounts: TrackedAccount[]) {}

  public convertAssociation(request: ConvertAccountAssociationRequest) {
    const selected = this.accounts.find(
      (account) => account.guildId === request.guildId && account.id === request.accountId,
    );
    if (selected === undefined) {
      return Promise.resolve({ kind: 'account_not_found' as const });
    }
    if (selected.association.type === request.targetAssociation.type) {
      return Promise.resolve({ kind: 'association_unchanged' as const });
    }
    if (!canConvertAccountAssociation(selected, request)) {
      return Promise.resolve({ kind: 'forbidden' as const });
    }
    this.conversions.push({ accountId: request.accountId, guildId: request.guildId });
    selected.association = request.targetAssociation;
    selected.isDefault = request.targetAssociation.type === 'linked';
    selected.quotaOwnerDiscordUserId =
      request.targetAssociation.type === 'linked'
        ? request.targetAssociation.discordUserId
        : selected.registeredByDiscordUserId;
    return Promise.resolve({ kind: 'converted' as const, account: selected });
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

function watchlistAccount(overrides: Partial<TrackedAccount> = {}): TrackedAccount {
  return account({ association: { type: 'watchlist' }, isDefault: false, ...overrides });
}
