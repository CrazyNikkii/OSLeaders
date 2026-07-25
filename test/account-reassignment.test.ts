import { describe, expect, it } from 'vitest';

import {
  canReassignLinkedAccount,
  LinkedAccountReassignmentService,
  type LinkedAccountReassignmentRepository,
  type ReassignLinkedAccountRequest,
} from '../src/features/accounts/reassign-linked-account.js';
import type { TrackedAccount } from '../src/features/accounts/register-account.js';

describe('linked-account reassignment service', () => {
  it('allows an account manager to reassign a linked account', async () => {
    const repository = new RecordingRepository([account()]);
    const service = new LinkedAccountReassignmentService(repository);

    await expect(
      service.reassign({
        accountId: 'account-one',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
        targetDiscordUserId: 'member-two',
      }),
    ).resolves.toMatchObject({
      kind: 'reassigned',
      account: {
        association: { type: 'linked', discordUserId: 'member-two' },
        quotaOwnerDiscordUserId: 'member-two',
      },
    });
  });

  it('rejects self-service, watchlist, cross-guild, and unchanged reassignments', async () => {
    const repository = new RecordingRepository([
      account(),
      account({ association: { type: 'watchlist' }, id: 'watchlist-one', isDefault: false }),
      account({ guildId: 'guild-two', id: 'account-two' }),
    ]);
    const service = new LinkedAccountReassignmentService(repository);

    await expect(
      service.reassign({
        accountId: 'account-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        targetDiscordUserId: 'member-two',
      }),
    ).resolves.toEqual({ kind: 'forbidden' });
    await expect(
      service.reassign({
        accountId: 'watchlist-one',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
        targetDiscordUserId: 'member-two',
      }),
    ).resolves.toEqual({ kind: 'account_not_linked' });
    await expect(
      service.reassign({
        accountId: 'account-two',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
        targetDiscordUserId: 'member-two',
      }),
    ).resolves.toEqual({ kind: 'account_not_found' });
    await expect(
      service.reassign({
        accountId: 'account-one',
        canManageAccounts: true,
        guildId: 'guild-one',
        requesterDiscordUserId: 'manager-one',
        targetDiscordUserId: 'member-one',
      }),
    ).resolves.toEqual({ kind: 'reassignment_unchanged' });
    expect(repository.reassignments).toEqual([]);
  });
});

class RecordingRepository implements LinkedAccountReassignmentRepository {
  public readonly reassignments: { accountId: string; guildId: string }[] = [];

  public constructor(private readonly accounts: TrackedAccount[]) {}

  public reassignLinkedAccount(request: ReassignLinkedAccountRequest) {
    const selected = this.accounts.find(
      (account) => account.guildId === request.guildId && account.id === request.accountId,
    );
    if (selected === undefined) {
      return Promise.resolve({ kind: 'account_not_found' as const });
    }
    if (!request.canManageAccounts) {
      return Promise.resolve({ kind: 'forbidden' as const });
    }
    if (selected.association.type !== 'linked') {
      return Promise.resolve({ kind: 'account_not_linked' as const });
    }
    if (!canReassignLinkedAccount(selected, request)) {
      return Promise.resolve({ kind: 'forbidden' as const });
    }
    if (selected.association.discordUserId === request.targetDiscordUserId) {
      return Promise.resolve({ kind: 'reassignment_unchanged' as const });
    }
    this.reassignments.push({ accountId: request.accountId, guildId: request.guildId });
    selected.association = { type: 'linked', discordUserId: request.targetDiscordUserId };
    selected.quotaOwnerDiscordUserId = request.targetDiscordUserId;
    return Promise.resolve({ kind: 'reassigned' as const, account: selected });
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
