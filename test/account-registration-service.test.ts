import { describe, expect, it } from 'vitest';

import {
  AccountRegistrationService,
  normalizeOsrsUsername,
  type AccountModeValidationService,
  type AccountRegistrationRepository,
  type InitialRecapBaseline,
  type TrackedAccount,
} from '../src/features/accounts/register-account.js';
import type { HiscoreResult } from '../src/infrastructure/hiscores/hiscore-result.js';

describe('account registration service', () => {
  it('validates before persisting and records the returned display name', async () => {
    const validator = new StubValidator(success('Rune Scape'));
    const repository = new RecordingRepository();
    const service = new AccountRegistrationService(validator, repository);

    await expect(
      service.register({
        accountMode: 'main',
        association: { type: 'linked', discordUserId: 'member-one' },
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        username: 'submitted name',
      }),
    ).resolves.toMatchObject({
      kind: 'registered',
      account: {
        displayUsername: 'Rune Scape',
        normalizedUsername: 'rune scape',
        quotaOwnerDiscordUserId: 'member-one',
        registeredByDiscordUserId: 'member-one',
      },
    });
    expect(validator.requests).toEqual([{ accountMode: 'main', username: 'submitted name' }]);
    expect(repository.accounts).toHaveLength(1);
    const [baseline] = repository.initialRecapBaselines;
    expect(baseline).toMatchObject({
      bossKillCounts: { Zulrah: 12 },
      skillExperience: { Attack: 1234 },
      skillLevels: { Attack: 10 },
    });
    expect(baseline?.capturedAt).toBeInstanceOf(Date);
  });

  it('rejects a normal member registering a linked account for somebody else', async () => {
    const validator = new StubValidator(success('Rune Scape'));
    const repository = new RecordingRepository();
    const service = new AccountRegistrationService(validator, repository);

    await expect(
      service.register({
        accountMode: 'main',
        association: { type: 'linked', discordUserId: 'member-two' },
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        username: 'Rune Scape',
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    expect(validator.requests).toEqual([]);
    expect(repository.accounts).toEqual([]);
  });

  it('charges an administrator-created linked account to its linked member', async () => {
    const repository = new RecordingRepository();
    const service = new AccountRegistrationService(
      new StubValidator(success('Rune Scape')),
      repository,
    );

    await service.register({
      accountMode: 'main',
      association: { type: 'linked', discordUserId: 'member-two' },
      canManageAccounts: true,
      guildId: 'guild-one',
      requesterDiscordUserId: 'administrator',
      username: 'Rune Scape',
    });

    expect(repository.accounts[0]).toMatchObject({
      quotaOwnerDiscordUserId: 'member-two',
      registeredByDiscordUserId: 'administrator',
    });
  });

  it('allows any member to add a watchlist account and charges their quota', async () => {
    const repository = new RecordingRepository();
    const service = new AccountRegistrationService(
      new StubValidator(success('Rune Scape')),
      repository,
    );

    await service.register({
      accountMode: 'group_ironman',
      association: { type: 'watchlist' },
      canManageAccounts: false,
      guildId: 'guild-one',
      requesterDiscordUserId: 'member-one',
      username: 'Rune Scape',
    });

    expect(repository.accounts[0]).toMatchObject({
      association: { type: 'watchlist' },
      quotaOwnerDiscordUserId: 'member-one',
    });
  });

  it('does not persist when mode validation fails', async () => {
    const failure = { kind: 'mode_incompatible' } as const;
    const repository = new RecordingRepository();
    const service = new AccountRegistrationService(new StubValidator(failure), repository);

    await expect(
      service.register({
        accountMode: 'ironman',
        association: { type: 'watchlist' },
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        username: 'Rune Scape',
      }),
    ).resolves.toEqual({ kind: 'hiscores_failure', failure });
    expect(repository.accounts).toEqual([]);
  });
});

describe('OSRS username normalization', () => {
  it('normalizes case, Unicode spacing, and surrounding whitespace', () => {
    expect(normalizeOsrsUsername('  RUNE\u00a0\u00a0Scape  ')).toBe('rune scape');
  });
});

class StubValidator implements AccountModeValidationService {
  public readonly requests: { accountMode: string; username: string }[] = [];

  public constructor(private readonly result: HiscoreResult) {}

  public validate(request: { accountMode: 'main'; username: string }): Promise<HiscoreResult>;
  public validate(request: { accountMode: string; username: string }): Promise<HiscoreResult> {
    this.requests.push(request);
    return Promise.resolve(this.result);
  }
}

class RecordingRepository implements AccountRegistrationRepository {
  public readonly accounts: Omit<TrackedAccount, 'createdAt' | 'isDefault'>[] = [];
  public readonly initialRecapBaselines: InitialRecapBaseline[] = [];

  public register(
    account: Omit<TrackedAccount, 'createdAt' | 'isDefault'>,
    initialRecapBaseline: InitialRecapBaseline,
  ) {
    this.accounts.push(account);
    this.initialRecapBaselines.push(initialRecapBaseline);
    return Promise.resolve({
      kind: 'registered' as const,
      account: { ...account, createdAt: new Date('2026-07-25T00:00:00.000Z'), isDefault: true },
    });
  }
}

function success(returnedName: string): Extract<HiscoreResult, { kind: 'success' }> {
  return {
    accountMode: 'main',
    data: {
      activities: [],
      bosses: [{ id: 1, name: 'Zulrah', rank: 2, score: 12 }],
      returnedName,
      skills: [{ experience: 1234, id: 1, level: 10, name: 'Attack', rank: 2 }],
    },
    endpoint: 'hiscore_oldschool',
    kind: 'success',
    modeVerification: 'server_managed',
  };
}
