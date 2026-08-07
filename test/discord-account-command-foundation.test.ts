import { Events, MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import {
  AccountDefaultSelectionCommandHandler,
  AccountModeCommandHandler,
  AccountRenameCommandHandler,
  AccountRemovalCommandHandler,
  AccountRegistrationCommandHandler,
  DiscordRegistrationAnnouncementPublisher,
  DiscordRegistrationAdministrativeLogPublisher,
  DiscordRenameAdministrativeLogPublisher,
  DiscordAccountCommandAdapter,
  InMemoryAccountRegistrationSessionStore,
  InMemoryDestructiveConfirmationStore,
  accountCommandDefinitions,
  bindDiscordAccountCommandAdapter,
  createAccountDefaultSelectionCommandHandler,
  createAccountModeCommandHandler,
  createAccountRenameCommandHandler,
  createDiscordAccountCommandAdapter,
  type AccountCommandPermissionEvaluator,
  type AccountDefaultSelectionCommandServices,
  type AccountModeCommandServices,
  type AccountRenameCommandServices,
  type AccountRegistrationCommandServices,
  type AccountRemovalCommandServices,
  type GuildInteractionContext,
  type RegistrationAnnouncementPublisher,
  type RegistrationAdministrativeLogPublisher,
  type RenameAdministrativeLogPublisher,
  type ModeAdministrativeLogPublisher,
} from '../src/infrastructure/discord/account-command-foundation.js';
import type {
  AccountRegistrationResult,
  RegisterAccountRequest,
  TrackedAccount,
} from '../src/features/accounts/register-account.js';
import type { RenameAccountResult } from '../src/features/accounts/rename-account.js';
import type { ChangeAccountModeResult } from '../src/features/accounts/change-account-mode.js';
import type { AuditService } from '../src/features/audit/audit-service.js';
import type { StructuredLogEntry } from '../src/shared/structured-logging.js';

describe('Discord account command foundation', () => {
  it('does not dispatch interactions rejected by the binding predicate', async () => {
    const listeners = new Map<string, (interaction: never) => void>();
    const client = {
      on: (event: string, listener: (interaction: never) => void) => {
        listeners.set(event, listener);
      },
    };
    const adapter = { handle: vi.fn(() => Promise.resolve()) };

    bindDiscordAccountCommandAdapter(
      client as never,
      adapter as never,
      () => undefined,
      (interaction) => interaction.guildId === 'guild-one',
    );

    const listener = listeners.get(Events.InteractionCreate);
    if (listener === undefined) {
      throw new Error('Expected an interaction listener.');
    }
    listener({ guildId: 'guild-two' } as never);
    listener({ guildId: 'guild-one', isAutocomplete: () => true } as never);
    await Promise.resolve();

    expect(adapter.handle).toHaveBeenCalledOnce();
    expect(adapter.handle).toHaveBeenCalledWith(expect.objectContaining({ guildId: 'guild-one' }));
  });

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

  it('delivers registration logs only to the configured channel in the same guild', async () => {
    const configuration = new AdministrativeLogConfigurationStub({
      administrativeLogChannelId: 'administrative-channel',
      administrativeLogMode: 'standard',
    });
    const publisher = new DiscordRegistrationAdministrativeLogPublisher(configuration);
    const messages: unknown[] = [];

    await publisher.publish(
      {
        guildId: 'guild-one',
        guild: {
          channels: {
            fetch: (channelId: string) => {
              expect(channelId).toBe('administrative-channel');
              return Promise.resolve({
                isSendable: () => true,
                send: (message: unknown) => {
                  messages.push(message);
                  return Promise.resolve();
                },
              });
            },
          },
        },
      } as never,
      'Registered **Rune Scape** as an Ironman watchlist account.',
    );

    expect(configuration.guildIds).toEqual(['guild-one']);
    expect(messages).toEqual([
      { content: 'Registered **Rune Scape** as an Ironman watchlist account.' },
    ]);
  });

  it('skips registration logs when no administrative channel is configured', async () => {
    const configuration = new AdministrativeLogConfigurationStub({
      administrativeLogChannelId: null,
      administrativeLogMode: 'standard',
    });
    const publisher = new DiscordRegistrationAdministrativeLogPublisher(configuration);

    await expect(
      publisher.publish({ guildId: 'guild-one', guild: null } as never, 'registration log'),
    ).resolves.toBeUndefined();
    expect(configuration.guildIds).toEqual(['guild-one']);
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
          {
            name: 'default',
            options: [{ autocomplete: true, name: 'account', required: true }],
          },
          {
            name: 'rename',
            options: [{ autocomplete: true, name: 'account', required: true }],
          },
          {
            name: 'mode',
            options: [{ autocomplete: true, name: 'account', required: true }],
          },
        ],
      },
    ]);
  });

  it('requires administrative-log delivery whenever registration support is enabled', () => {
    const removalHandler = new AccountRemovalCommandHandler(new StubServices([]));
    const registrationHandler = new AccountRegistrationCommandHandler(
      new RegistrationStubServices(),
    );

    expect(
      () =>
        new DiscordAccountCommandAdapter(
          removalHandler,
          defaultSelectionHandler(),
          registrationHandler,
        ),
    ).toThrow('Registration support requires an administrative log publisher.');
    expect(
      createDiscordAccountCommandAdapter(
        removalHandler,
        defaultSelectionHandler(),
        registrationHandler,
        new AccountRenameCommandHandler(new RenameStubServices([])),
        new AccountModeCommandHandler(new ModeStubServices([])),
        new AdministrativeLogConfigurationStub({
          administrativeLogChannelId: null,
          administrativeLogMode: 'standard',
        }),
      ),
    ).toBeInstanceOf(DiscordAccountCommandAdapter);
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

  it('selects default accounts through the existing service and only autocompletes eligible linked accounts', async () => {
    const services = new DefaultSelectionStubServices([
      account({ displayUsername: 'Mine', id: 'mine', isDefault: false }),
      account({ association: { discordUserId: 'member-two', type: 'linked' }, id: 'other' }),
      account({ association: { type: 'watchlist' }, id: 'watchlist' }),
    ]);
    const handler = new AccountDefaultSelectionCommandHandler(services);

    await expect(handler.autocomplete(context(), '')).resolves.toEqual([
      { name: 'Mine (main)', value: 'mine' },
    ]);
    await expect(handler.select(context(), 'mine')).resolves.toEqual({
      kind: 'selected',
      message: '**Mine** is now the default account.',
    });
    expect(services.selectionRequests).toEqual([
      {
        accountId: 'mine',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
      },
    ]);
    await expect(handler.select(context(), 'other')).resolves.toMatchObject({ kind: 'forbidden' });
    await expect(handler.select(context(), 'watchlist')).resolves.toMatchObject({
      kind: 'account_not_found',
    });
    await expect(handler.select(context({ guildId: null }), 'mine')).resolves.toMatchObject({
      kind: 'not_in_guild',
    });

    services.canManageAccounts = true;
    await expect(
      handler.autocomplete(context({ requesterDiscordUserId: 'manager-one' }), ''),
    ).resolves.toEqual([
      { name: 'Mine (main)', value: 'mine' },
      { name: 'Account One (main)', value: 'other' },
    ]);
  });

  it('maps default-account selection through an ephemeral Discord response', async () => {
    const services = new DefaultSelectionStubServices([account({ isDefault: false })]);
    const adapter = new DiscordAccountCommandAdapter(
      new AccountRemovalCommandHandler(new StubServices([])),
      new AccountDefaultSelectionCommandHandler(services),
    );
    const replies: unknown[] = [];

    await adapter.handle({
      commandName: 'account',
      guildId: 'guild-one',
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => true,
      member: { roles: [] },
      memberPermissions: { has: () => false },
      options: {
        getString: () => 'account-one',
        getSubcommand: () => 'default',
      },
      reply: (response: unknown) => {
        replies.push(response);
        return Promise.resolve();
      },
      user: { id: 'member-one' },
    } as never);

    expect(replies).toEqual([
      {
        content: '**Account One** is now the default account.',
        flags: MessageFlags.Ephemeral,
      },
    ]);
  });

  it('renames only eligible guild accounts and presents the result ephemerally', async () => {
    const services = new RenameStubServices([
      account(),
      account({ association: { discordUserId: 'member-two', type: 'linked' }, id: 'other' }),
      account({ guildId: 'guild-two', id: 'elsewhere' }),
    ]);
    const handler = new AccountRenameCommandHandler(services);

    await expect(handler.autocomplete(context(), '')).resolves.toEqual([
      { name: 'Account One (main)', value: 'account-one' },
    ]);
    await expect(handler.rename(context(), 'account-one', 'Renamed One')).resolves.toMatchObject({
      kind: 'renamed',
      message: 'Renamed the tracked account to **Renamed One**.',
    });
    expect(services.renameRequests).toEqual([
      {
        accountId: 'account-one',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
        username: 'Renamed One',
      },
    ]);
    const [auditEvent] = services.auditEvents;
    expect(auditEvent?.context).toEqual({
      accountId: 'account-one',
      accountMode: 'main',
      actorDiscordUserId: 'member-one',
      associationType: 'linked',
      newDisplayUsername: 'Renamed One',
      previousDisplayUsername: 'Account One',
    });
    expect(auditEvent?.guildId).toBe('guild-one');
    expect(auditEvent?.operation).toBe('account.rename');
    expect(auditEvent?.type).toBe('account-edit-or-deletion');
    await expect(
      handler.rename(context({ guildId: null }), 'account-one', 'Ignored'),
    ).resolves.toMatchObject({
      kind: 'not_in_guild',
    });
  });

  it('creates the rename handler from shared account repositories', () => {
    const validator = { validate: () => Promise.resolve({ kind: 'not_found' as const }) };
    const services = new RenameStubServices([]);
    expect(
      createAccountRenameCommandHandler(
        new DefaultSelectionRepositoryStub([]) as never,
        validator,
        services.audit,
        services,
      ),
    ).toBeInstanceOf(AccountRenameCommandHandler);
  });

  it('changes only eligible guild accounts, validates the selected mode, and audits the edit', async () => {
    const services = new ModeStubServices([
      account(),
      account({ association: { discordUserId: 'member-two', type: 'linked' }, id: 'other' }),
      account({ guildId: 'guild-two', id: 'elsewhere' }),
    ]);
    const handler = new AccountModeCommandHandler(services);

    await expect(handler.autocomplete(context(), '')).resolves.toEqual([
      { name: 'Account One (main)', value: 'account-one' },
    ]);
    await expect(handler.change(context(), 'account-one', 'ironman')).resolves.toMatchObject({
      kind: 'mode_changed',
      message: 'Changed **Account One** to Ironman.',
    });
    expect(services.changeRequests).toEqual([
      {
        accountId: 'account-one',
        accountMode: 'ironman',
        canManageAccounts: false,
        guildId: 'guild-one',
        requesterDiscordUserId: 'member-one',
      },
    ]);
    expect(services.auditEvents[0]).toMatchObject({
      operation: 'account.mode_change',
      type: 'account-edit-or-deletion',
    });
    expect(services.auditEvents[0]?.context).toMatchObject({
      accountMode: 'ironman',
      displayUsername: 'Account One',
    });
    await expect(
      handler.change(context({ guildId: null }), 'account-one', 'ironman'),
    ).resolves.toMatchObject({
      kind: 'not_in_guild',
    });
  });

  it('opens a text-labelled mode selection, applies the change privately, and logs it', async () => {
    const services = new ModeStubServices([account()]);
    const logs = new RecordingModeAdministrativeLogPublisher();
    const adapter = new DiscordAccountCommandAdapter(
      new AccountRemovalCommandHandler(new StubServices([])),
      defaultSelectionHandler(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new AccountModeCommandHandler(services),
      logs,
    );
    const replies: ComponentResponse[] = [];
    await adapter.handle({
      commandName: 'account',
      guildId: 'guild-one',
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => true,
      member: { roles: [] },
      memberPermissions: { has: () => false },
      options: { getString: () => 'account-one', getSubcommand: () => 'mode' },
      reply: (response: ComponentResponse) => {
        replies.push(response);
        return Promise.resolve();
      },
      user: { id: 'member-one' },
    } as never);
    const customId = replies[0]?.components[0]?.toJSON().components[0]?.custom_id;
    expect(replies[0]?.components[0]?.toJSON().components[0]?.options).toContainEqual(
      expect.objectContaining({ label: 'Ironman', value: 'ironman' }),
    );
    const edits: unknown[] = [];
    await adapter.handle({
      customId,
      guildId: 'guild-one',
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => false,
      isStringSelectMenu: () => true,
      member: { roles: [] },
      memberPermissions: { has: () => false },
      values: ['ironman'],
      deferUpdate: () => Promise.resolve(),
      editReply: (response: unknown) => {
        edits.push(response);
        return Promise.resolve();
      },
      user: { id: 'member-one' },
    } as never);
    expect(edits).toEqual([{ components: [], content: 'Changed **Account One** to Ironman.' }]);
    expect(logs.operations).toEqual(['account.mode_change']);
  });

  it('keeps invalid, forbidden, and failed mode selections private without logging an edit', async () => {
    const services = new ModeStubServices([account()]);
    const logs = new RecordingModeAdministrativeLogPublisher();
    const adapter = new DiscordAccountCommandAdapter(
      new AccountRemovalCommandHandler(new StubServices([])),
      defaultSelectionHandler(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new AccountModeCommandHandler(services),
      logs,
    );
    const replies: unknown[] = [];
    const edits: unknown[] = [];
    let deferredUpdates = 0;
    const interaction = (value: string) =>
      ({
        customId: 'osleaders:account-mode:account-one',
        guildId: 'guild-one',
        isAutocomplete: () => false,
        isButton: () => false,
        isChatInputCommand: () => false,
        isStringSelectMenu: () => true,
        member: { roles: [] },
        memberPermissions: { has: () => false },
        values: [value],
        deferUpdate: () => {
          deferredUpdates += 1;
          return Promise.resolve();
        },
        editReply: (response: unknown) => {
          edits.push(response);
          return Promise.resolve();
        },
        reply: (response: unknown) => {
          replies.push(response);
          return Promise.resolve();
        },
        user: { id: 'member-one' },
      }) as never;

    await adapter.handle(interaction('not-a-mode'));
    services.modeResult = { kind: 'forbidden' };
    await adapter.handle(interaction('ironman'));
    services.modeResult = { kind: 'hiscores_failure', failure: { kind: 'not_found' } };
    await adapter.handle(interaction('ironman'));

    expect(replies).toEqual([
      { content: 'That account mode is invalid.', flags: MessageFlags.Ephemeral },
    ]);
    expect(deferredUpdates).toBe(2);
    expect(edits).toEqual([
      { components: [], content: 'You are not allowed to change that account mode.' },
      {
        components: [],
        content: 'That OSRS account could not be found for the selected mode.',
      },
    ]);
    expect(logs.operations).toEqual([]);
  });

  it('creates the mode-change handler from shared account repositories', () => {
    const validator = { validate: () => Promise.resolve({ kind: 'not_found' as const }) };
    const services = new ModeStubServices([]);
    expect(
      createAccountModeCommandHandler(
        new DefaultSelectionRepositoryStub([]) as never,
        validator,
        services.audit,
        services,
      ),
    ).toBeInstanceOf(AccountModeCommandHandler);
  });

  it('opens a rename modal, delegates its submission, and logs successful edits', async () => {
    const services = new RenameStubServices([account()]);
    const renameLogs = new RecordingRenameAdministrativeLogPublisher();
    const adapter = new DiscordAccountCommandAdapter(
      new AccountRemovalCommandHandler(new StubServices([])),
      defaultSelectionHandler(),
      undefined,
      undefined,
      undefined,
      new AccountRenameCommandHandler(services),
      renameLogs,
    );
    const modals: ModalResponse[] = [];
    await adapter.handle({
      commandName: 'account',
      guildId: 'guild-one',
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => true,
      member: { roles: [] },
      memberPermissions: { has: () => false },
      options: { getString: () => 'account-one', getSubcommand: () => 'rename' },
      showModal: (modal: ModalResponse) => {
        modals.push(modal);
        return Promise.resolve();
      },
      user: { id: 'member-one' },
    } as never);

    expect(modals).toHaveLength(1);
    const customId = modals[0]?.toJSON().custom_id;
    if (customId === undefined) {
      throw new Error('Expected a rename modal.');
    }
    const replies: unknown[] = [];
    await adapter.handle({
      customId,
      fields: { getTextInputValue: () => 'Renamed One' },
      guildId: 'guild-one',
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => true,
      member: { roles: [] },
      memberPermissions: { has: () => false },
      reply: (response: unknown) => {
        replies.push(response);
        return Promise.resolve();
      },
      user: { id: 'member-one' },
    } as never);

    expect(replies).toEqual([
      { content: 'Renamed the tracked account to **Renamed One**.', flags: MessageFlags.Ephemeral },
    ]);
    expect(renameLogs.messages).toEqual(['recorded']);
  });

  it('does not let an administrative-log failure undo a successful rename', async () => {
    const adapter = new DiscordAccountCommandAdapter(
      new AccountRemovalCommandHandler(new StubServices([])),
      defaultSelectionHandler(),
      undefined,
      undefined,
      undefined,
      new AccountRenameCommandHandler(new RenameStubServices([account()])),
      new FailingRenameAdministrativeLogPublisher(),
    );
    const replies: unknown[] = [];
    await adapter.handle({
      customId: 'osleaders:account-rename:account-one',
      fields: { getTextInputValue: () => 'Renamed One' },
      guildId: 'guild-one',
      isAutocomplete: () => false,
      isButton: () => false,
      isChatInputCommand: () => false,
      isModalSubmit: () => true,
      member: { roles: [] },
      memberPermissions: { has: () => false },
      reply: (response: unknown) => {
        replies.push(response);
        return Promise.resolve();
      },
      user: { id: 'member-one' },
    } as never);
    expect(replies).toEqual([
      { content: 'Renamed the tracked account to **Renamed One**.', flags: MessageFlags.Ephemeral },
    ]);
  });

  it('delivers rename logs only to the configured guild channel', async () => {
    const configuration = new AdministrativeLogConfigurationStub({
      administrativeLogChannelId: 'administrative-channel',
      administrativeLogMode: 'standard',
    });
    const publisher = new DiscordRenameAdministrativeLogPublisher(configuration);
    const messages: unknown[] = [];
    await publisher.publish(
      {
        guildId: 'guild-one',
        guild: {
          channels: {
            fetch: () =>
              Promise.resolve({
                isSendable: () => true,
                send: (message: unknown) => {
                  messages.push(message);
                  return Promise.resolve();
                },
              }),
          },
        },
      } as never,
      auditEntry(),
    );
    expect(configuration.guildIds).toEqual(['guild-one']);
    expect(messages).toEqual([
      { content: 'Renamed tracked account **Account One** to **Renamed One** by <@member-one>.' },
    ]);
  });

  it('creates the default-selection handler from shared account repositories', () => {
    const repository = new DefaultSelectionRepositoryStub([account({ isDefault: false })]);
    expect(createAccountDefaultSelectionCommandHandler(repository, repository)).toBeInstanceOf(
      AccountDefaultSelectionCommandHandler,
    );
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
    const adapter = new DiscordAccountCommandAdapter(
      new AccountRemovalCommandHandler(services),
      defaultSelectionHandler(),
    );
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
      flags: MessageFlags;
    };
    expect(response.flags).toBe(MessageFlags.Ephemeral);
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
      defaultSelectionHandler(),
      new AccountRegistrationCommandHandler(registrationServices),
      undefined,
      new RecordingRegistrationAdministrativeLogPublisher(),
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
    const administrativeLogs = new RecordingRegistrationAdministrativeLogPublisher();
    const adapter = new DiscordAccountCommandAdapter(
      new AccountRemovalCommandHandler(new StubServices([])),
      defaultSelectionHandler(),
      new AccountRegistrationCommandHandler(services),
      announcements,
      administrativeLogs,
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
    expect(administrativeLogs.messages).toEqual([
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
      defaultSelectionHandler(),
      handler,
      failedAnnouncements,
      new RecordingRegistrationAdministrativeLogPublisher(),
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
      defaultSelectionHandler(),
      deliveryFailureHandler,
      new FailingRegistrationAnnouncementPublisher(),
      new FailingRegistrationAdministrativeLogPublisher(),
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

class DefaultSelectionStubServices
  implements AccountDefaultSelectionCommandServices, AccountCommandPermissionEvaluator
{
  public canManageAccounts = false;
  public readonly selectionRequests: object[] = [];
  public readonly permissions = this;
  public readonly accountRetrieval = {
    listForGuild: (guildId: string) =>
      Promise.resolve(this.accounts.filter((account) => account.guildId === guildId)),
  };
  public readonly defaultAccountSelection = {
    select: (request: {
      accountId: string;
      canManageAccounts: boolean;
      guildId: string;
      requesterDiscordUserId: string;
    }) => {
      this.selectionRequests.push(request);
      const selected = this.accounts.find(
        (account) => account.guildId === request.guildId && account.id === request.accountId,
      );
      if (selected?.association.type !== 'linked') {
        return Promise.resolve({ kind: 'account_not_found' as const });
      }
      if (
        selected.association.discordUserId !== request.requesterDiscordUserId &&
        !request.canManageAccounts
      ) {
        return Promise.resolve({ kind: 'forbidden' as const });
      }
      return Promise.resolve({ account: selected, kind: 'selected' as const });
    },
  };

  public constructor(protected readonly accounts: TrackedAccount[]) {}

  public evaluate(): Promise<{ canManageAccounts: boolean; canManageCompetitions: boolean }> {
    return Promise.resolve({
      canManageAccounts: this.canManageAccounts,
      canManageCompetitions: false,
    });
  }
}

class RenameStubServices
  implements AccountRenameCommandServices, AccountCommandPermissionEvaluator
{
  public readonly auditEvents: Parameters<AuditService['record']>[0][] = [];
  public canManageAccounts = false;
  public readonly permissions = this;
  public readonly renameRequests: object[] = [];
  public renameResult: RenameAccountResult = {
    account: account({ displayUsername: 'Renamed One' }),
    kind: 'renamed',
    previousDisplayUsername: 'Account One',
  };
  public readonly audit = {
    record: (event: Parameters<AuditService['record']>[0]): StructuredLogEntry => {
      this.auditEvents.push(event);
      return {
        ...(event.context === undefined ? {} : { context: event.context }),
        ...(event.guildId === undefined ? {} : { guildId: event.guildId }),
        operation: event.operation,
        severity: event.severity,
        timestamp: event.occurredAt.toISOString(),
      };
    },
  };
  public readonly accountRetrieval = {
    listForGuild: (guildId: string) =>
      Promise.resolve(this.accounts.filter((account) => account.guildId === guildId)),
  };
  public readonly accountRename = {
    rename: (request: object) => {
      this.renameRequests.push(request);
      return Promise.resolve(this.renameResult);
    },
  };

  public constructor(private readonly accounts: TrackedAccount[]) {}

  public evaluate(): Promise<{ canManageAccounts: boolean; canManageCompetitions: boolean }> {
    return Promise.resolve({
      canManageAccounts: this.canManageAccounts,
      canManageCompetitions: false,
    });
  }
}

class ModeStubServices implements AccountModeCommandServices, AccountCommandPermissionEvaluator {
  public readonly auditEvents: Parameters<AuditService['record']>[0][] = [];
  public canManageAccounts = false;
  public readonly permissions = this;
  public readonly changeRequests: object[] = [];
  public modeResult: ChangeAccountModeResult = {
    account: account({ accountMode: 'ironman' }),
    kind: 'mode_changed',
  };
  public readonly audit = {
    record: (event: Parameters<AuditService['record']>[0]): StructuredLogEntry => {
      this.auditEvents.push(event);
      return {
        ...(event.context === undefined ? {} : { context: event.context }),
        ...(event.guildId === undefined ? {} : { guildId: event.guildId }),
        operation: event.operation,
        severity: event.severity,
        timestamp: event.occurredAt.toISOString(),
      };
    },
  };
  public readonly accountRetrieval = {
    listForGuild: (guildId: string) =>
      Promise.resolve(this.accounts.filter((account) => account.guildId === guildId)),
  };
  public readonly accountModeChange = {
    change: (request: object) => {
      this.changeRequests.push(request);
      return Promise.resolve(this.modeResult);
    },
  };

  public constructor(private readonly accounts: TrackedAccount[]) {}

  public evaluate(): Promise<{ canManageAccounts: boolean; canManageCompetitions: boolean }> {
    return Promise.resolve({
      canManageAccounts: this.canManageAccounts,
      canManageCompetitions: false,
    });
  }
}

class DefaultSelectionRepositoryStub extends DefaultSelectionStubServices {
  public getById(guildId: string, accountId: string) {
    return Promise.resolve(
      this.accounts.find((account) => account.guildId === guildId && account.id === accountId),
    );
  }

  public selectDefault(guildId: string, discordUserId: string, accountId: string) {
    return this.defaultAccountSelection
      .select({
        accountId,
        canManageAccounts: true,
        guildId,
        requesterDiscordUserId: discordUserId,
      })
      .then((result) => (result.kind === 'selected' ? result.account : undefined));
  }

  public getDefaultForMember(guildId: string, discordUserId: string) {
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

  public listForGuild(guildId: string) {
    return Promise.resolve(this.accounts.filter((account) => account.guildId === guildId));
  }

  public listLinkedForMember(guildId: string, discordUserId: string) {
    return Promise.resolve(
      this.accounts.filter(
        (account) =>
          account.guildId === guildId &&
          account.association.type === 'linked' &&
          account.association.discordUserId === discordUserId,
      ),
    );
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

class RecordingRegistrationAdministrativeLogPublisher implements RegistrationAdministrativeLogPublisher {
  public readonly messages: string[] = [];

  public publish(_interaction: unknown, message: string): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }
}

class FailingRegistrationAdministrativeLogPublisher implements RegistrationAdministrativeLogPublisher {
  public publish(): Promise<void> {
    return Promise.reject(new Error('Discord administrative channel unavailable'));
  }
}

class RecordingRenameAdministrativeLogPublisher implements RenameAdministrativeLogPublisher {
  public readonly messages: string[] = [];

  public publish(_interaction: unknown, auditEntry: StructuredLogEntry): Promise<void> {
    this.messages.push(auditEntry.operation === 'account.rename' ? 'recorded' : 'unexpected');
    return Promise.resolve();
  }
}

class FailingRenameAdministrativeLogPublisher implements RenameAdministrativeLogPublisher {
  public publish(): Promise<void> {
    return Promise.reject(new Error('Discord administrative channel unavailable'));
  }
}

class RecordingModeAdministrativeLogPublisher implements ModeAdministrativeLogPublisher {
  public readonly operations: string[] = [];

  public publish(_interaction: unknown, auditEntry: StructuredLogEntry): Promise<void> {
    this.operations.push(auditEntry.operation);
    return Promise.resolve();
  }
}

class AdministrativeLogConfigurationStub {
  public readonly guildIds: string[] = [];

  public constructor(
    private readonly configuration: {
      administrativeLogChannelId: string | null;
      administrativeLogMode: 'standard' | 'verbose';
    },
  ) {}

  public getOrCreate(guildId: string) {
    this.guildIds.push(guildId);
    return Promise.resolve({
      ...this.configuration,
      botManagerRoleId: null,
      competitionManagerRoleId: null,
      guildId,
      modeEmojis: {},
      recapChannelId: null,
      recapEnabled: false,
      recapLocalTime: null,
      timezone: 'Europe/Helsinki',
    });
  }
}

interface ModalResponse {
  toJSON(): { custom_id: string; title: string };
}

interface ComponentResponse {
  components: { toJSON(): { components: { custom_id: string; options?: unknown[] }[] } }[];
  content: string;
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

function defaultSelectionHandler(): AccountDefaultSelectionCommandHandler {
  return new AccountDefaultSelectionCommandHandler(new DefaultSelectionStubServices([]));
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

function auditEntry(overrides: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  return {
    context: {
      actorDiscordUserId: 'member-one',
      newDisplayUsername: 'Renamed One',
      previousDisplayUsername: 'Account One',
    },
    guildId: 'guild-one',
    operation: 'account.rename',
    severity: 'info',
    timestamp: '2026-07-30T12:00:00.000Z',
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
