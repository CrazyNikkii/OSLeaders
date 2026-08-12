import { describe, expect, it } from 'vitest';

import type { AccountRetrievalRepository } from '../src/features/accounts/account-retrieval.js';
import {
  AccountRenameService,
  type AccountRenameRepository,
} from '../src/features/accounts/rename-account.js';
import type {
  AccountModeValidationService,
  TrackedAccount,
} from '../src/features/accounts/register-account.js';
import type { HiscoreResult } from '../src/infrastructure/hiscores/hiscore-result.js';

describe('account rename service', () => {
  it('validates the stored mode and preserves the account identity while renaming', async () => {
    const repository = new RecordingRepository([account()]);
    const validator = new StubValidator(success('Renamed Account'));
    const service = new AccountRenameService(validator, repository, repository);

    await expect(
      service.rename({
        accountId: 'account-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        username: 'submitted name',
      }),
    ).resolves.toMatchObject({
      kind: 'renamed',
      account: {
        displayUsername: 'Renamed Account',
        id: 'account-one',
        normalizedUsername: 'renamed account',
      },
      previousDisplayUsername: 'Rune Scape',
    });
    expect(validator.requests).toEqual([{ accountMode: 'ironman', username: 'submitted name' }]);
  });

  it('allows the watchlist registrant and an account manager to rename a watchlist account', async () => {
    const watchlist = account({
      association: { type: 'watchlist' },
      registeredByDiscordUserId: 'watchlist-owner',
    });
    const repository = new RecordingRepository([watchlist]);
    const service = new AccountRenameService(
      new StubValidator(success('Watchlisted')),
      repository,
      repository,
    );

    await expect(
      service.rename({
        accountId: 'account-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'watchlist-owner',
        username: 'Watchlisted',
      }),
    ).resolves.toMatchObject({ kind: 'renamed' });
    await expect(
      service.rename({
        accountId: 'account-one',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
        username: 'Watchlisted Again',
      }),
    ).resolves.toMatchObject({ kind: 'renamed' });
  });

  it('blocks self-service active-competition renames but retains the manager-approved path', async () => {
    const repository = new RecordingRepository([account()], undefined, true);
    const service = new AccountRenameService(
      new StubValidator(success('Approved Rename')),
      repository,
      repository,
    );

    await expect(
      service.rename({
        accountId: 'account-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        username: 'Approved Rename',
      }),
    ).resolves.toEqual({ kind: 'active_competition_locked' });
    await expect(
      service.rename({
        accountId: 'account-one',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
        activeCompetitionRenameConfirmed: true,
        username: 'Approved Rename',
      }),
    ).resolves.toMatchObject({ kind: 'renamed', previousDisplayUsername: 'Rune Scape' });
  });

  it('rejects unauthorized, cross-guild, invalid, and failed validation requests without renaming', async () => {
    const repository = new RecordingRepository([
      account(),
      account({ guildId: 'guild-two', id: 'account-two' }),
    ]);
    const service = new AccountRenameService(
      new StubValidator({ kind: 'not_found' }),
      repository,
      repository,
    );

    await expect(
      service.rename({
        accountId: 'account-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-two',
        username: 'New Name',
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    await expect(
      service.rename({
        accountId: 'account-two',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
        username: 'New Name',
      }),
    ).resolves.toEqual({ kind: 'account_not_found' });
    await expect(
      service.rename({
        accountId: 'account-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        username: 'New Name',
      }),
    ).resolves.toEqual({ kind: 'hiscores_failure', failure: { kind: 'not_found' } });
    expect(repository.renames).toEqual([]);
  });

  it('returns a normalized-name conflict from the repository', async () => {
    const repository = new RecordingRepository([account()], 'username_taken');
    const service = new AccountRenameService(
      new StubValidator(success('Taken Name')),
      repository,
      repository,
    );

    await expect(
      service.rename({
        accountId: 'account-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        username: 'Taken Name',
      }),
    ).resolves.toEqual({ kind: 'username_taken' });
  });
});

class StubValidator implements AccountModeValidationService {
  public readonly requests: { accountMode: string; username: string }[] = [];

  public constructor(private readonly result: HiscoreResult) {}

  public validate(request: { accountMode: string; username: string }): Promise<HiscoreResult> {
    this.requests.push(request);
    return Promise.resolve(this.result);
  }
}

class RecordingRepository implements AccountRetrievalRepository, AccountRenameRepository {
  public readonly renames: { accountId: string; guildId: string; username: string }[] = [];

  public constructor(
    private readonly accounts: TrackedAccount[],
    private readonly renameResult: 'username_taken' | undefined = undefined,
    private readonly activeCompetition = false,
  ) {}

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

  public async rename(
    guildId: string,
    accountId: string,
    username: { displayUsername: string; normalizedUsername: string },
    canManageAccounts = false,
  ) {
    const selected = await this.getById(guildId, accountId);
    if (selected === undefined) {
      return { kind: 'account_not_found' as const };
    }
    if (this.renameResult !== undefined) {
      return { kind: this.renameResult };
    }
    if (this.activeCompetition && !canManageAccounts) {
      return { kind: 'active_competition_locked' as const };
    }
    this.renames.push({ accountId, guildId, username: username.normalizedUsername });
    selected.displayUsername = username.displayUsername;
    selected.normalizedUsername = username.normalizedUsername;
    return { kind: 'renamed' as const, account: selected };
  }
}

function account(overrides: Partial<TrackedAccount> = {}): TrackedAccount {
  return {
    accountMode: 'ironman',
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

function success(returnedName: string): Extract<HiscoreResult, { kind: 'success' }> {
  return {
    accountMode: 'ironman',
    data: { activities: [], bosses: [], returnedName, skills: [] },
    endpoint: 'hiscore_oldschool_ironman',
    kind: 'success',
    modeVerification: 'endpoint_verified',
  };
}
