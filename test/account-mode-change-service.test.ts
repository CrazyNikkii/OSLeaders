import { describe, expect, it } from 'vitest';

import type { AccountRetrievalRepository } from '../src/features/accounts/account-retrieval.js';
import {
  AccountModeChangeService,
  type AccountModeChangeRepository,
} from '../src/features/accounts/change-account-mode.js';
import type {
  AccountModeValidationService,
  TrackedAccount,
} from '../src/features/accounts/register-account.js';
import type { HiscoreResult } from '../src/infrastructure/hiscores/hiscore-result.js';
import type { OsrsAccountMode } from '../src/infrastructure/hiscores/osrs-hiscore-catalog.js';

describe('account mode change service', () => {
  it('validates the stored username against the selected mode before changing it', async () => {
    const repository = new RecordingRepository([account()]);
    const validator = new StubValidator(success());
    const service = new AccountModeChangeService(validator, repository, repository);

    await expect(
      service.change({
        accountId: 'account-one',
        accountMode: 'hardcore_ironman',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toMatchObject({
      kind: 'mode_changed',
      account: { accountMode: 'hardcore_ironman', id: 'account-one' },
    });
    expect(validator.requests).toEqual([
      { accountMode: 'hardcore_ironman', username: 'Rune Scape' },
    ]);
  });

  it('allows a watchlist registrant and an account manager to change a watchlist mode', async () => {
    const repository = new RecordingRepository([
      account({ association: { type: 'watchlist' }, registeredByDiscordUserId: 'watchlist-owner' }),
    ]);
    const service = new AccountModeChangeService(
      new StubValidator(success()),
      repository,
      repository,
    );

    await expect(
      service.change({
        accountId: 'account-one',
        accountMode: 'ironman',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'watchlist-owner',
      }),
    ).resolves.toMatchObject({ kind: 'mode_changed' });
    await expect(
      service.change({
        accountId: 'account-one',
        accountMode: 'ultimate_ironman',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
      }),
    ).resolves.toMatchObject({ kind: 'mode_changed' });
  });

  it('rejects unauthorized, cross-guild, and failed-validation requests without changing the mode', async () => {
    const repository = new RecordingRepository([
      account(),
      account({ guildId: 'guild-two', id: 'account-two' }),
    ]);
    const service = new AccountModeChangeService(
      new StubValidator({ kind: 'not_found' }),
      repository,
      repository,
    );

    await expect(
      service.change({
        accountId: 'account-one',
        accountMode: 'ironman',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-two',
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    await expect(
      service.change({
        accountId: 'account-two',
        accountMode: 'ironman',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
      }),
    ).resolves.toEqual({ kind: 'account_not_found' });
    await expect(
      service.change({
        accountId: 'account-one',
        accountMode: 'ironman',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
      }),
    ).resolves.toEqual({ kind: 'hiscores_failure', failure: { kind: 'not_found' } });
    expect(repository.changes).toEqual([]);
  });
});

class StubValidator implements AccountModeValidationService {
  public readonly requests: { accountMode: OsrsAccountMode; username: string }[] = [];

  public constructor(private readonly result: HiscoreResult) {}

  public validate(request: {
    accountMode: OsrsAccountMode;
    username: string;
  }): Promise<HiscoreResult> {
    this.requests.push(request);
    return Promise.resolve(this.result);
  }
}

class RecordingRepository implements AccountRetrievalRepository, AccountModeChangeRepository {
  public readonly changes: { accountId: string; accountMode: OsrsAccountMode; guildId: string }[] =
    [];

  public constructor(private readonly accounts: TrackedAccount[]) {}

  public getById(guildId: string, accountId: string): Promise<TrackedAccount | undefined> {
    return Promise.resolve(
      this.accounts.find((account) => account.guildId === guildId && account.id === accountId),
    );
  }

  public getDefaultForMember(): Promise<TrackedAccount | undefined> {
    return Promise.resolve(undefined);
  }

  public listForGuild(): Promise<TrackedAccount[]> {
    return Promise.resolve([]);
  }

  public listLinkedForMember(): Promise<TrackedAccount[]> {
    return Promise.resolve([]);
  }

  public async changeMode(guildId: string, accountId: string, accountMode: OsrsAccountMode) {
    const selected = await this.getById(guildId, accountId);
    if (selected === undefined) {
      return { kind: 'account_not_found' as const };
    }
    this.changes.push({ accountId, accountMode, guildId });
    selected.accountMode = accountMode;
    return { kind: 'mode_changed' as const, account: selected };
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

function success(): Extract<HiscoreResult, { kind: 'success' }> {
  return {
    accountMode: 'hardcore_ironman',
    data: { activities: [], bosses: [], returnedName: 'Rune Scape', skills: [] },
    endpoint: 'hiscore_oldschool_hardcore_ironman',
    kind: 'success',
    modeVerification: 'endpoint_verified',
  };
}
