import { describe, expect, it } from 'vitest';

import {
  AccountRemovalCommandHandler,
  DiscordAccountCommandAdapter,
  InMemoryDestructiveConfirmationStore,
  accountCommandDefinitions,
  type AccountCommandPermissionEvaluator,
  type AccountRemovalCommandServices,
  type GuildInteractionContext,
} from '../src/infrastructure/discord/account-command-foundation.js';
import type { TrackedAccount } from '../src/features/accounts/register-account.js';

describe('Discord account command foundation', () => {
  it('registers a guild-only account removal command with account autocomplete', () => {
    expect(accountCommandDefinitions).toEqual([
      expect.objectContaining({
        description: 'Manage tracked OSRS accounts.',
        name: 'account',
        options: [
          expect.objectContaining({
            name: 'remove',
            options: [
              expect.objectContaining({ autocomplete: true, name: 'account', required: true }),
            ],
          }),
        ],
      }),
    ]);
  });

  it('binds confirmation to the initiating user and does not remove before confirmation', async () => {
    const services = new StubServices([account()]);
    const handler = new AccountRemovalCommandHandler(services);

    const prompt = await handler.requestRemoval(context(), 'account-one');

    expect(prompt).toMatchObject({ kind: 'confirmation_required' });
    expect(services.removalRequests).toEqual([]);
    if (prompt.kind !== 'confirmation_required') {
      throw new Error('Expected a confirmation prompt.');
    }

    await expect(
      handler.confirmRemoval(context({ requesterDiscordUserId: 'member-two' }), prompt.customId),
    ).resolves.toMatchObject({ kind: 'forbidden' });
    expect(services.removalRequests).toEqual([]);

    await expect(handler.confirmRemoval(context(), prompt.customId)).resolves.toMatchObject({
      kind: 'removed',
    });
    expect(services.removalRequests).toEqual([
      expect.objectContaining({ accountId: 'account-one', guildId: 'guild-one' }),
    ]);
  });

  it('only offers removable accounts from the current guild', async () => {
    const handler = new AccountRemovalCommandHandler(
      new StubServices([
        account({ displayUsername: 'Mine', id: 'mine' }),
        account({
          association: { discordUserId: 'member-two', type: 'linked' },
          id: 'another-member',
        }),
        account({ displayUsername: 'Elsewhere', guildId: 'guild-two', id: 'elsewhere' }),
      ]),
    );

    await expect(handler.autocomplete(context(), '')).resolves.toEqual([
      { name: 'Mine (main)', value: 'mine' },
    ]);
  });

  it('allows a configured account manager to confirm removal for another member', async () => {
    const services = new StubServices([
      account({ association: { discordUserId: 'member-two', type: 'linked' } }),
    ]);
    services.permissions.canManageAccounts = true;
    const handler = new AccountRemovalCommandHandler(services);

    const prompt = await handler.requestRemoval(
      context({ requesterDiscordUserId: 'manager-one' }),
      'account-one',
    );
    if (prompt.kind !== 'confirmation_required') {
      throw new Error('Expected a confirmation prompt.');
    }

    await expect(
      handler.confirmRemoval(context({ requesterDiscordUserId: 'manager-one' }), prompt.customId),
    ).resolves.toMatchObject({ kind: 'removed' });
  });

  it('rejects malformed or cross-user confirmation identifiers', async () => {
    const handler = new AccountRemovalCommandHandler(new StubServices([account()]));

    await expect(
      handler.confirmRemoval(context(), 'osleaders:account-remove:member-one'),
    ).resolves.toMatchObject({
      kind: 'forbidden',
    });
    await expect(
      handler.confirmRemoval(context(), 'osleaders:account-remove:member-two:account-one'),
    ).resolves.toMatchObject({ kind: 'forbidden' });
  });

  it('expires, binds to its guild, and consumes removal confirmations', async () => {
    const services = new StubServices([account()]);
    const handler = new AccountRemovalCommandHandler(services);
    const prompt = await handler.requestRemoval(context(), 'account-one');
    if (prompt.kind !== 'confirmation_required') {
      throw new Error('Expected a confirmation prompt.');
    }

    await expect(
      handler.confirmRemoval(context({ guildId: 'guild-two' }), prompt.customId),
    ).resolves.toMatchObject({ kind: 'forbidden' });
    await expect(handler.confirmRemoval(context(), prompt.customId)).resolves.toMatchObject({
      kind: 'removed',
    });
    await expect(handler.confirmRemoval(context(), prompt.customId)).resolves.toMatchObject({
      kind: 'forbidden',
    });

    const expiringPrompt = await handler.requestRemoval(context(), 'account-one');
    if (expiringPrompt.kind !== 'confirmation_required') {
      throw new Error('Expected a confirmation prompt.');
    }
    services.clock.advanceBy(5 * 60 * 1000);

    await expect(handler.confirmRemoval(context(), expiringPrompt.customId)).resolves.toMatchObject(
      {
        kind: 'confirmation_expired',
      },
    );
  });

  it('prunes expired confirmations and bounds abandoned confirmations', () => {
    const clock = new MutableClock();
    const store = new InMemoryDestructiveConfirmationStore(clock, 2);
    const expiredId = store.create(confirmation({ expiresAt: clock.now() }));
    clock.advanceBy(1);
    const activeId = store.create(confirmation({ expiresAt: later(clock, 5 * 60 * 1000) }));

    expect(store.consume(expiredId, confirmationBinding())).toBeUndefined();
    expect(store.consume(activeId, confirmationBinding())).toMatchObject({
      accountId: 'account-one',
    });

    const firstId = store.create(confirmation({ accountId: 'first' }));
    const secondId = store.create(confirmation({ accountId: 'second' }));
    const thirdId = store.create(confirmation({ accountId: 'third' }));

    expect(store.consume(firstId, confirmationBinding())).toBeUndefined();
    expect(store.consume(secondId, confirmationBinding())).toMatchObject({ accountId: 'second' });
    expect(store.consume(thirdId, confirmationBinding())).toMatchObject({ accountId: 'third' });
  });

  it('maps Discord interaction permissions and roles, replies ephemerally, and updates confirmations', async () => {
    const services = new StubServices([
      account({ association: { discordUserId: 'member-two', type: 'linked' } }),
    ]);
    services.canManageAccounts = true;
    const adapter = new DiscordAccountCommandAdapter(new AccountRemovalCommandHandler(services));
    const replies: unknown[] = [];
    const command = {
      commandName: 'account',
      guildId: 'guild-one',
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => true,
      member: { roles: { cache: new Map([['bot-manager-role', {}]]) } },
      memberPermissions: { has: () => false },
      options: {
        getString: () => 'account-one',
        getSubcommand: () => 'remove',
      },
      reply: (response: unknown) => {
        replies.push(response);
        return Promise.resolve();
      },
      user: { id: 'manager-one' },
    };

    await adapter.handle(command as never);

    expect(services.permissionRequests).toEqual([
      expect.objectContaining({
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        memberRoleIds: ['bot-manager-role'],
      }),
    ]);
    expect(replies).toHaveLength(1);
    const response = replies[0] as {
      components: { components: { data: { custom_id: string } }[] }[];
      ephemeral: boolean;
    };
    expect(response.ephemeral).toBe(true);
    const customId = response.components[0]?.components[0]?.data.custom_id;
    if (customId === undefined) {
      throw new Error('Expected a confirmation button.');
    }

    const edits: unknown[] = [];
    let deferred = false;
    const button = {
      customId,
      deferUpdate: () => {
        deferred = true;
        return Promise.resolve();
      },
      editReply: (response: unknown) => {
        edits.push(response);
        return Promise.resolve();
      },
      guildId: 'guild-one',
      isAutocomplete: () => false,
      isButton: () => true,
      isChatInputCommand: () => false,
      member: { roles: { cache: new Map([['bot-manager-role', {}]]) } },
      memberPermissions: { has: () => false },
      user: { id: 'manager-one' },
    };

    await adapter.handle(button as never);

    expect(deferred).toBe(true);
    expect(edits).toEqual([
      expect.objectContaining({ components: [], content: 'Removed **Account One**.' }),
    ]);
  });
});

class StubServices implements AccountRemovalCommandServices, AccountCommandPermissionEvaluator {
  public readonly removalRequests: object[] = [];
  public readonly permissionRequests: unknown[] = [];
  public canManageAccounts = false;
  public readonly clock = new MutableClock();
  public readonly confirmations = new InMemoryDestructiveConfirmationStore(this.clock);

  public readonly accountRetrieval = {
    getById: (guildId: string, accountId: string) =>
      Promise.resolve(
        this.accounts.find((account) => account.guildId === guildId && account.id === accountId),
      ),
    listForGuild: (guildId: string) =>
      Promise.resolve(this.accounts.filter((account) => account.guildId === guildId)),
  };

  public readonly accountRemoval = {
    remove: async (request: { accountId: string; guildId: string }) => {
      this.removalRequests.push(request);
      const removed = await this.accountRetrieval.getById(request.guildId, request.accountId);
      return removed === undefined
        ? { kind: 'account_not_found' as const }
        : { account: removed, kind: 'removed' as const };
    },
  };

  public readonly permissions = this;

  public constructor(private readonly accounts: TrackedAccount[]) {}

  public evaluate(
    request: unknown,
  ): Promise<{ canManageAccounts: boolean; canManageCompetitions: boolean }> {
    this.permissionRequests.push(request);
    return Promise.resolve({
      canManageAccounts: this.canManageAccounts,
      canManageCompetitions: false,
    });
  }
}

class MutableClock {
  private current = new Date('2026-07-25T00:00:00.000Z');

  public now(): Date {
    return this.current;
  }

  public advanceBy(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

function context(overrides: Partial<GuildInteractionContext> = {}): GuildInteractionContext {
  return {
    guildId: 'guild-one',
    hasAdministratorPermission: false,
    memberRoleIds: [],
    requesterDiscordUserId: 'member-one',
    ...overrides,
  };
}

function account(overrides: Partial<TrackedAccount> = {}): TrackedAccount {
  return {
    accountMode: 'main',
    association: { discordUserId: 'member-one', type: 'linked' },
    createdAt: new Date('2026-07-25T00:00:00.000Z'),
    displayUsername: 'Account One',
    guildId: 'guild-one',
    id: 'account-one',
    isDefault: true,
    normalizedUsername: 'account one',
    quotaOwnerDiscordUserId: 'member-one',
    registeredByDiscordUserId: 'member-one',
    ...overrides,
  };
}

function confirmation(
  overrides: Partial<
    import('../src/infrastructure/discord/account-command-foundation.js').DestructiveConfirmation
  > = {},
) {
  return {
    accountId: 'account-one',
    action: 'account_remove' as const,
    expiresAt: new Date('2026-07-25T00:05:00.000Z'),
    guildId: 'guild-one',
    requesterDiscordUserId: 'member-one',
    ...overrides,
  };
}

function confirmationBinding() {
  return {
    action: 'account_remove' as const,
    guildId: 'guild-one',
    requesterDiscordUserId: 'member-one',
  };
}

function later(clock: MutableClock, milliseconds: number): Date {
  return new Date(clock.now().getTime() + milliseconds);
}
