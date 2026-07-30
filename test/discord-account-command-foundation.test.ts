import { describe, expect, it } from 'vitest';

import {
  AccountRemovalCommandHandler,
  AccountRegistrationCommandHandler,
  DiscordRegistrationAnnouncementPublisher,
  DiscordAccountCommandAdapter,
  InMemoryAccountRegistrationSessionStore,
  InMemoryDestructiveConfirmationStore,
  accountCommandDefinitions,
  type AccountCommandPermissionEvaluator,
  type AccountRegistrationCommandServices,
  type AccountRemovalCommandServices,
  type GuildInteractionContext,
  type RegistrationAnnouncementPublisher,
} from '../src/infrastructure/discord/account-command-foundation.js';
import type {
  AccountRegistrationResult,
  RegisterAccountRequest,
  TrackedAccount,
} from '../src/features/accounts/register-account.js';

describe('Discord account command foundation', () => {
  it('publishes registration announcements through a sendable interaction channel', async () => {
    const publisher = new DiscordRegistrationAnnouncementPublisher();
    const messages: unknown[] = [];

    await publisher.publish(
      {
        channel: {
          isSendable: () => true,
          send: (message: unknown) => {
            messages.push(message);
            return Promise.resolve();
          },
        },
      } as never,
      '**Rune Scape** has been registered as a Main linked account.',
    );

    expect(messages).toEqual([
      { content: '**Rune Scape** has been registered as a Main linked account.' },
    ]);
    await expect(
      publisher.publish({ channel: null } as never, 'registration announcement'),
    ).rejects.toThrow('not available for public announcements');
  });

  it('registers guild-only account removal and guided registration commands', () => {
    expect(accountCommandDefinitions).toMatchObject([
      {
        description: 'Manage tracked OSRS accounts.',
        name: 'account',
        options: [
          { name: 'register' },
          {
            name: 'remove',
            options: [{ autocomplete: true, name: 'account', required: true }],
          },
        ],
      },
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

  it('guides a normal member through watchlist registration and delegates only after mode selection', async () => {
    const services = new RegistrationStubServices();
    const handler = new AccountRegistrationCommandHandler(services);

    const start = await handler.start(context());
    if (start.kind !== 'username_required') {
      throw new Error('Expected a username prompt.');
    }
    const username = handler.submitUsername(context(), start.customId, 'Rune Scape');
    if (username.kind !== 'association_selection') {
      throw new Error('Expected an association prompt.');
    }
    const association = await handler.selectAssociation(context(), username.customId, 'watchlist');
    if (association.kind !== 'mode_selection') {
      throw new Error('Expected a game-mode prompt.');
    }

    await expect(handler.selectMode(context(), association.customId, 'ironman')).resolves.toEqual({
      kind: 'completed',
      message: 'That OSRS username is already tracked in this server.',
    });
    expect(services.registrationRequests).toEqual([
      expect.objectContaining({
        accountMode: 'ironman',
        association: { type: 'watchlist' },
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        username: 'Rune Scape',
      }),
    ]);
  });

  it('opens an ephemeral-bound username modal for /account register', async () => {
    const registrationServices = new RegistrationStubServices();
    const adapter = new DiscordAccountCommandAdapter(
      new AccountRemovalCommandHandler(new StubServices([])),
      new AccountRegistrationCommandHandler(registrationServices),
    );
    const modals: { toJSON(): { custom_id: string; title: string } }[] = [];
    const command = {
      commandName: 'account',
      guildId: 'guild-one',
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => true,
      member: { roles: [] },
      memberPermissions: { has: () => false },
      options: { getSubcommand: () => 'register' },
      showModal: (modal: { toJSON(): { custom_id: string; title: string } }) => {
        modals.push(modal);
        return Promise.resolve();
      },
      user: { id: 'member-one' },
    };

    await adapter.handle(command as never);

    expect(modals).toHaveLength(1);
    const [modal] = modals;
    if (modal === undefined) {
      throw new Error('Expected a registration modal.');
    }
    expect(modal.toJSON().custom_id).toMatch(/^osleaders:account-register:username:/);
    expect(modal.toJSON().title).toBe('Register an OSRS account');
  });

  it('renders configured mode emojis and completes the Discord registration interaction chain', async () => {
    const services = new RegistrationStubServices();
    services.modeEmojis = { ironman: { id: 'emoji-one', name: 'ironman' } };
    services.registrationResult = {
      account: account({
        accountMode: 'ironman',
        association: { type: 'watchlist' },
        displayUsername: 'Rune Scape',
      }),
      kind: 'registered',
    };
    const announcements = new RecordingRegistrationAnnouncementPublisher();
    const adapter = new DiscordAccountCommandAdapter(
      new AccountRemovalCommandHandler(new StubServices([])),
      new AccountRegistrationCommandHandler(services),
      announcements,
    );
    const modals: ModalResponse[] = [];
    const replies: ComponentResponse[] = [];
    const updates: ComponentResponse[] = [];
    const edits: ComponentResponse[] = [];

    await adapter.handle(
      registrationCommand((modal) => {
        modals.push(modal);
        return Promise.resolve();
      }) as never,
    );
    const [modal] = modals;
    if (modal === undefined) {
      throw new Error('Expected a registration modal.');
    }

    await adapter.handle({
      customId: modal.toJSON().custom_id,
      fields: { getTextInputValue: () => 'Rune Scape' },
      guildId: 'guild-one',
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => true,
      member: { roles: [] },
      memberPermissions: { has: () => false },
      reply: (response: ComponentResponse) => {
        replies.push(response);
        return Promise.resolve();
      },
      user: { id: 'member-one' },
    } as never);
    const associationCustomId = componentCustomId(replies[0]);

    await adapter.handle(
      registrationSelectInteraction(associationCustomId, 'watchlist', (response) => {
        updates.push(response);
        return Promise.resolve();
      }) as never,
    );
    const modeResponse = updates[0];
    const modeCustomId = componentCustomId(modeResponse);
    const modeOptions = modeResponse?.components[0]?.toJSON().components[0]?.options;
    expect(modeOptions).toContainEqual(
      expect.objectContaining({
        emoji: { id: 'emoji-one', name: 'ironman' },
        label: 'Ironman',
        value: 'ironman',
      }),
    );

    await adapter.handle({
      ...registrationSelectInteraction(modeCustomId, 'ironman', () => Promise.resolve()),
      deferUpdate: () => Promise.resolve(),
      editReply: (response: ComponentResponse) => {
        edits.push(response);
        return Promise.resolve();
      },
    } as never);

    expect(edits).toEqual([
      expect.objectContaining({
        components: [],
        content: 'Registered **Rune Scape** as an Ironman watchlist account.',
      }),
    ]);
    expect(services.registrationRequests).toHaveLength(1);
    expect(announcements.messages).toEqual([
      '**Rune Scape** has been registered as an Ironman watchlist account.',
    ]);
  });

  it('does not announce unsuccessful registrations and reports announcement delivery failures privately', async () => {
    const services = new RegistrationStubServices();
    const handler = new AccountRegistrationCommandHandler(services);
    const start = await handler.start(context());
    if (start.kind !== 'username_required') {
      throw new Error('Expected a username prompt.');
    }
    const username = handler.submitUsername(context(), start.customId, 'Rune Scape');
    if (username.kind !== 'association_selection') {
      throw new Error('Expected an association prompt.');
    }
    const mode = await handler.selectAssociation(context(), username.customId, 'watchlist');
    if (mode.kind !== 'mode_selection') {
      throw new Error('Expected a game-mode prompt.');
    }

    const failedAnnouncements = new RecordingRegistrationAnnouncementPublisher();
    const adapter = new DiscordAccountCommandAdapter(
      new AccountRemovalCommandHandler(new StubServices([])),
      handler,
      failedAnnouncements,
    );
    const unsuccessfulEdits: ComponentResponse[] = [];
    await adapter.handle({
      ...registrationSelectInteraction(mode.customId, 'main', () => Promise.resolve()),
      deferUpdate: () => Promise.resolve(),
      editReply: (response: ComponentResponse) => {
        unsuccessfulEdits.push(response);
        return Promise.resolve();
      },
    } as never);
    expect(failedAnnouncements.messages).toEqual([]);
    expect(unsuccessfulEdits).toEqual([
      expect.objectContaining({ content: 'That OSRS username is already tracked in this server.' }),
    ]);

    services.registrationResult = { account: account(), kind: 'registered' };
    const deliveryFailureHandler = new AccountRegistrationCommandHandler(services);
    const deliveryFailureStart = await deliveryFailureHandler.start(context());
    if (deliveryFailureStart.kind !== 'username_required') {
      throw new Error('Expected a username prompt.');
    }
    const deliveryFailureUsername = deliveryFailureHandler.submitUsername(
      context(),
      deliveryFailureStart.customId,
      'Rune Scape',
    );
    if (deliveryFailureUsername.kind !== 'association_selection') {
      throw new Error('Expected an association prompt.');
    }
    const deliveryFailureMode = await deliveryFailureHandler.selectAssociation(
      context(),
      deliveryFailureUsername.customId,
      'watchlist',
    );
    if (deliveryFailureMode.kind !== 'mode_selection') {
      throw new Error('Expected a game-mode prompt.');
    }
    const deliveryFailureEdits: ComponentResponse[] = [];
    const failingAdapter = new DiscordAccountCommandAdapter(
      new AccountRemovalCommandHandler(new StubServices([])),
      deliveryFailureHandler,
      new FailingRegistrationAnnouncementPublisher(),
    );
    await failingAdapter.handle({
      ...registrationSelectInteraction(deliveryFailureMode.customId, 'main', () =>
        Promise.resolve(),
      ),
      deferUpdate: () => Promise.resolve(),
      editReply: (response: ComponentResponse) => {
        deliveryFailureEdits.push(response);
        return Promise.resolve();
      },
    } as never);
    expect(deliveryFailureEdits).toEqual([
      expect.objectContaining({ content: 'Registered **Account One** as a Main linked account.' }),
      expect.objectContaining({
        content:
          'Registered **Account One** as a Main linked account. The public registration announcement could not be posted.',
      }),
    ]);
  });

  it('requires an account manager to choose another member for a linked registration', async () => {
    const services = new RegistrationStubServices();
    services.canManageAccounts = true;
    const handler = new AccountRegistrationCommandHandler(services);
    const start = await handler.start(context({ requesterDiscordUserId: 'manager-one' }));
    if (start.kind !== 'username_required') {
      throw new Error('Expected a username prompt.');
    }
    const username = handler.submitUsername(
      context({ requesterDiscordUserId: 'manager-one' }),
      start.customId,
      'Rune Scape',
    );
    if (username.kind !== 'association_selection') {
      throw new Error('Expected an association prompt.');
    }
    const member = await handler.selectAssociation(
      context({ requesterDiscordUserId: 'manager-one' }),
      username.customId,
      'linked',
    );
    if (member.kind !== 'member_selection') {
      throw new Error('Expected a member picker.');
    }
    const mode = await handler.selectLinkedMember(
      context({ requesterDiscordUserId: 'manager-one' }),
      member.customId,
      'member-two',
    );
    if (mode.kind !== 'mode_selection') {
      throw new Error('Expected a game-mode prompt.');
    }

    await handler.selectMode(
      context({ requesterDiscordUserId: 'manager-one' }),
      mode.customId,
      'main',
    );
    expect(services.registrationRequests[0]).toMatchObject({
      association: { discordUserId: 'member-two', type: 'linked' },
      canManageAccounts: true,
    });
  });

  it('binds and expires registration sessions before they can register an account', async () => {
    const services = new RegistrationStubServices();
    const handler = new AccountRegistrationCommandHandler(services);
    const start = await handler.start(context());
    if (start.kind !== 'username_required') {
      throw new Error('Expected a username prompt.');
    }

    expect(
      handler.submitUsername(
        context({ requesterDiscordUserId: 'member-two' }),
        start.customId,
        'Rune Scape',
      ),
    ).toMatchObject({ kind: 'forbidden' });

    services.clock.advanceBy(5 * 60 * 1000);
    expect(handler.submitUsername(context(), start.customId, 'Rune Scape')).toMatchObject({
      kind: 'expired',
    });
    expect(services.registrationRequests).toEqual([]);
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

class RegistrationStubServices
  implements AccountRegistrationCommandServices, AccountCommandPermissionEvaluator
{
  public canManageAccounts = false;
  public readonly clock = new MutableClock();
  public readonly modeEmojiConfiguration = {
    getModeEmojis: () => Promise.resolve(this.modeEmojis),
  };
  public modeEmojis = {};
  public readonly registrationRequests: RegisterAccountRequest[] = [];
  public registrationResult: AccountRegistrationResult = { kind: 'username_taken' };
  public readonly sessions = new InMemoryAccountRegistrationSessionStore(this.clock);
  public readonly permissions = this;
  public readonly accountRegistration = {
    register: (request: RegisterAccountRequest) => {
      this.registrationRequests.push(request);
      return Promise.resolve(this.registrationResult);
    },
  };

  public evaluate(): Promise<{ canManageAccounts: boolean; canManageCompetitions: boolean }> {
    return Promise.resolve({
      canManageAccounts: this.canManageAccounts,
      canManageCompetitions: false,
    });
  }
}

class RecordingRegistrationAnnouncementPublisher implements RegistrationAnnouncementPublisher {
  public readonly messages: string[] = [];

  public publish(_interaction: unknown, message: string): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }
}

class FailingRegistrationAnnouncementPublisher implements RegistrationAnnouncementPublisher {
  public publish(): Promise<void> {
    return Promise.reject(new Error('Discord channel unavailable'));
  }
}

interface ModalResponse {
  toJSON(): { custom_id: string; title: string };
}

interface ComponentResponse {
  components: { toJSON(): { components: { custom_id: string; options?: unknown[] }[] } }[];
  content: string;
  ephemeral?: boolean;
}

function registrationCommand(showModal: (modal: ModalResponse) => Promise<void>) {
  return {
    commandName: 'account',
    guildId: 'guild-one',
    isAutocomplete: () => false,
    isButton: () => false,
    isChatInputCommand: () => true,
    member: { roles: [] },
    memberPermissions: { has: () => false },
    options: { getSubcommand: () => 'register' },
    showModal,
    user: { id: 'member-one' },
  };
}

function registrationSelectInteraction(
  customId: string,
  value: string,
  update: (response: ComponentResponse) => Promise<void>,
) {
  return {
    customId,
    guildId: 'guild-one',
    isAutocomplete: () => false,
    isButton: () => false,
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => true,
    member: { roles: [] },
    memberPermissions: { has: () => false },
    update,
    user: { id: 'member-one' },
    values: [value],
  };
}

function componentCustomId(response: ComponentResponse | undefined): string {
  const customId = response?.components[0]?.toJSON().components[0]?.custom_id;
  if (customId === undefined) {
    throw new Error('Expected a registration component custom ID.');
  }
  return customId;
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
