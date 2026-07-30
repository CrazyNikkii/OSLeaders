import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  ModalBuilder,
  PermissionFlagsBits,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ModalSubmitInteraction,
  type REST,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';

import {
  AccountRetrievalService,
  type AccountRetrievalRepository,
} from '../../features/accounts/account-retrieval.js';
import {
  AccountRegistrationService,
  type AccountAssociation,
  type AccountModeValidationService,
  type AccountRegistrationRepository,
  type AccountRegistrationResult,
} from '../../features/accounts/register-account.js';
import {
  AccountRemovalService,
  canRemoveAccount,
  type AccountRemovalRepository,
  type RemoveAccountResult,
} from '../../features/accounts/remove-account.js';
import {
  GuildPermissionService,
  type GuildPermissionRequest,
  type GuildPermissions,
} from '../../features/guild-configuration/guild-permission-service.js';
import {
  GuildConfigurationService,
  type GuildModeEmojis,
} from '../../features/guild-configuration/guild-configuration-service.js';
import {
  OSRS_ACCOUNT_MODES,
  type OsrsAccountMode,
} from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

const ACCOUNT_COMMAND_NAME = 'account';
const REGISTER_SUBCOMMAND_NAME = 'register';
const REMOVE_SUBCOMMAND_NAME = 'remove';
const ACCOUNT_OPTION_NAME = 'account';
const REMOVAL_CONFIRMATION_PREFIX = 'osleaders:account-remove';
const MAX_AUTOCOMPLETE_CHOICES = 25;
const MAX_PENDING_DESTRUCTIVE_CONFIRMATIONS = 1_000;
const REMOVAL_CONFIRMATION_LIFETIME_MS = 5 * 60 * 1000;
const REGISTRATION_INTERACTION_PREFIX = 'osleaders:account-register';
const REGISTRATION_INTERACTION_LIFETIME_MS = 5 * 60 * 1000;
const USERNAME_INPUT_ID = 'username';

export const accountCommandDefinitions = [
  new SlashCommandBuilder()
    .setName(ACCOUNT_COMMAND_NAME)
    .setDescription('Manage tracked OSRS accounts.')
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName(REGISTER_SUBCOMMAND_NAME)
        .setDescription('Register a tracked OSRS account through a guided flow.'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName(REMOVE_SUBCOMMAND_NAME)
        .setDescription('Remove a tracked OSRS account after confirmation.')
        .addStringOption((option) =>
          option
            .setName(ACCOUNT_OPTION_NAME)
            .setDescription('The account to remove.')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .toJSON(),
] as const;

export interface AccountCommandRegistrar {
  put(applicationId: string, commands: readonly object[]): Promise<void>;
}

export class DiscordAccountCommandRegistrar implements AccountCommandRegistrar {
  public constructor(private readonly rest: REST) {}

  public async put(applicationId: string, commands: readonly object[]): Promise<void> {
    await this.rest.put(Routes.applicationCommands(applicationId), { body: commands });
  }
}

export interface AccountCommandPermissionEvaluator {
  evaluate(request: GuildPermissionRequest): Promise<GuildPermissions>;
}

export interface AccountRemovalCommandServices {
  accountRetrieval: Pick<AccountRetrievalService, 'getById' | 'listForGuild'>;
  accountRemoval: Pick<AccountRemovalService, 'remove'>;
  clock: Clock;
  confirmations: DestructiveConfirmationStore;
  permissions: AccountCommandPermissionEvaluator;
}

export interface Clock {
  now(): Date;
}

export interface DestructiveConfirmation {
  accountId: string;
  action: 'account_remove';
  expiresAt: Date;
  guildId: string;
  requesterDiscordUserId: string;
}

export interface DestructiveConfirmationStore {
  create(confirmation: DestructiveConfirmation): string;
  consume(
    confirmationId: string,
    expected: Pick<DestructiveConfirmation, 'action' | 'guildId' | 'requesterDiscordUserId'>,
  ): DestructiveConfirmation | 'expired' | 'mismatch' | undefined;
}

export class InMemoryDestructiveConfirmationStore implements DestructiveConfirmationStore {
  private readonly confirmations = new Map<string, DestructiveConfirmation>();

  public constructor(
    private readonly clock: Clock = systemClock,
    private readonly maximumPendingConfirmations = MAX_PENDING_DESTRUCTIVE_CONFIRMATIONS,
  ) {
    if (!Number.isSafeInteger(maximumPendingConfirmations) || maximumPendingConfirmations < 1) {
      throw new Error('maximumPendingConfirmations must be a positive safe integer.');
    }
  }

  public create(confirmation: DestructiveConfirmation): string {
    this.pruneExpired();
    this.evictOldestUntilBelowCapacity();
    const confirmationId = randomUUID();
    this.confirmations.set(confirmationId, confirmation);
    return confirmationId;
  }

  public consume(
    confirmationId: string,
    expected: Pick<DestructiveConfirmation, 'action' | 'guildId' | 'requesterDiscordUserId'>,
  ): DestructiveConfirmation | 'expired' | 'mismatch' | undefined {
    const confirmation = this.confirmations.get(confirmationId);
    if (confirmation === undefined) {
      return undefined;
    }
    if (confirmation.expiresAt.getTime() <= this.clock.now().getTime()) {
      this.confirmations.delete(confirmationId);
      return 'expired';
    }
    if (
      confirmation.action !== expected.action ||
      confirmation.guildId !== expected.guildId ||
      confirmation.requesterDiscordUserId !== expected.requesterDiscordUserId
    ) {
      return 'mismatch';
    }

    this.confirmations.delete(confirmationId);
    return confirmation;
  }

  private pruneExpired(): void {
    const now = this.clock.now().getTime();
    for (const [confirmationId, confirmation] of this.confirmations) {
      if (confirmation.expiresAt.getTime() <= now) {
        this.confirmations.delete(confirmationId);
      }
    }
  }

  private evictOldestUntilBelowCapacity(): void {
    while (this.confirmations.size >= this.maximumPendingConfirmations) {
      const oldestConfirmationId = this.confirmations.keys().next().value;
      if (oldestConfirmationId === undefined) {
        return;
      }
      this.confirmations.delete(oldestConfirmationId);
    }
  }
}

export interface GuildInteractionContext {
  guildId: string | null;
  hasAdministratorPermission: boolean;
  memberRoleIds: readonly string[];
  requesterDiscordUserId: string;
}

export type AccountRemovalCommandResult =
  | { kind: 'confirmation_required'; customId: string; message: string }
  | { kind: 'confirmation_expired'; message: string }
  | { kind: 'removed'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'account_not_found'; message: string }
  | { kind: 'not_in_guild'; message: string };

export class AccountRemovalCommandHandler {
  public constructor(private readonly services: AccountRemovalCommandServices) {}

  public async requestRemoval(
    context: GuildInteractionContext,
    accountId: string,
  ): Promise<AccountRemovalCommandResult> {
    const authorization = await this.authorize(context);
    if (authorization === undefined) {
      return notInGuild();
    }

    const account = await this.services.accountRetrieval.getById(authorization.guildId, accountId);
    if (account === undefined) {
      return accountNotFound();
    }
    if (
      !canRemoveAccount(account, {
        ...authorization,
        accountId: account.id,
      })
    ) {
      return forbidden();
    }

    return {
      customId: encodeRemovalConfirmation(
        this.services.confirmations.create({
          accountId: account.id,
          action: 'account_remove',
          expiresAt: new Date(
            this.services.clock.now().getTime() + REMOVAL_CONFIRMATION_LIFETIME_MS,
          ),
          guildId: authorization.guildId,
          requesterDiscordUserId: authorization.requesterDiscordUserId,
        }),
      ),
      kind: 'confirmation_required',
      message: `Remove **${account.displayUsername}**? This also removes its daily recap baseline.`,
    };
  }

  public async confirmRemoval(
    context: GuildInteractionContext,
    customId: string,
  ): Promise<AccountRemovalCommandResult> {
    const authorization = await this.authorize(context);
    if (authorization === undefined) {
      return notInGuild();
    }

    const confirmationId = decodeRemovalConfirmation(customId);
    if (confirmationId === undefined) {
      return forbidden();
    }

    const confirmation = this.services.confirmations.consume(confirmationId, {
      action: 'account_remove',
      guildId: authorization.guildId,
      requesterDiscordUserId: authorization.requesterDiscordUserId,
    });
    if (confirmation === 'expired') {
      return confirmationExpired();
    }
    if (confirmation === 'mismatch' || confirmation === undefined) {
      return forbidden();
    }

    return toCommandResult(
      await this.services.accountRemoval.remove({
        accountId: confirmation.accountId,
        canManageAccounts: authorization.canManageAccounts,
        guildId: authorization.guildId,
        requesterDiscordUserId: authorization.requesterDiscordUserId,
      }),
    );
  }

  public async autocomplete(
    context: GuildInteractionContext,
    query: string,
  ): Promise<{ name: string; value: string }[]> {
    const authorization = await this.authorize(context);
    if (authorization === undefined) {
      return [];
    }

    const normalizedQuery = query.trim().toLocaleLowerCase('en-US');
    const accounts = await this.services.accountRetrieval.listForGuild(authorization.guildId);
    return accounts
      .filter((account) => canRemoveAccount(account, { ...authorization, accountId: account.id }))
      .filter((account) =>
        account.displayUsername.toLocaleLowerCase('en-US').includes(normalizedQuery),
      )
      .slice(0, MAX_AUTOCOMPLETE_CHOICES)
      .map((account) => ({
        name: `${account.displayUsername} (${account.accountMode})`,
        value: account.id,
      }));
  }

  private async authorize(
    context: GuildInteractionContext,
  ): Promise<
    | (GuildPermissionRequest & { canManageAccounts: boolean; requesterDiscordUserId: string })
    | undefined
  > {
    if (context.guildId === null) {
      return undefined;
    }

    const permissions = await this.services.permissions.evaluate({
      guildId: context.guildId,
      hasAdministratorPermission: context.hasAdministratorPermission,
      memberRoleIds: context.memberRoleIds,
    });
    return {
      ...context,
      canManageAccounts: permissions.canManageAccounts,
      guildId: context.guildId,
    };
  }
}

export interface AccountRegistrationCommandServices {
  accountRegistration: Pick<AccountRegistrationService, 'register'>;
  clock: Clock;
  modeEmojiConfiguration: GuildModeEmojiProvider;
  permissions: AccountCommandPermissionEvaluator;
  sessions: AccountRegistrationSessionStore;
}

type RegistrationAssociationKind = AccountAssociation['type'];

export interface AccountRegistrationSession {
  associationKind?: RegistrationAssociationKind;
  linkedDiscordUserId?: string;
  expiresAt: Date;
  guildId: string;
  requesterDiscordUserId: string;
  username?: string;
}

export interface AccountRegistrationSessionStore {
  create(session: AccountRegistrationSession): string;
  consume(
    sessionId: string,
    expected: Pick<AccountRegistrationSession, 'guildId' | 'requesterDiscordUserId'>,
  ): AccountRegistrationSession | 'expired' | 'mismatch' | undefined;
  read(
    sessionId: string,
    expected: Pick<AccountRegistrationSession, 'guildId' | 'requesterDiscordUserId'>,
  ): AccountRegistrationSession | 'expired' | 'mismatch' | undefined;
  update(
    sessionId: string,
    expected: Pick<AccountRegistrationSession, 'guildId' | 'requesterDiscordUserId'>,
    update: Pick<
      AccountRegistrationSession,
      'associationKind' | 'linkedDiscordUserId' | 'username'
    >,
  ): AccountRegistrationSession | 'expired' | 'mismatch' | undefined;
}

export class InMemoryAccountRegistrationSessionStore implements AccountRegistrationSessionStore {
  private readonly sessions = new Map<string, AccountRegistrationSession>();

  public constructor(
    private readonly clock: Clock = systemClock,
    private readonly maximumPendingSessions = MAX_PENDING_DESTRUCTIVE_CONFIRMATIONS,
  ) {
    if (!Number.isSafeInteger(maximumPendingSessions) || maximumPendingSessions < 1) {
      throw new Error('maximumPendingSessions must be a positive safe integer.');
    }
  }

  public create(session: AccountRegistrationSession): string {
    this.pruneExpired();
    this.evictOldestUntilBelowCapacity();
    const sessionId = randomUUID();
    this.sessions.set(sessionId, session);
    return sessionId;
  }

  public consume(
    sessionId: string,
    expected: Pick<AccountRegistrationSession, 'guildId' | 'requesterDiscordUserId'>,
  ): AccountRegistrationSession | 'expired' | 'mismatch' | undefined {
    const session = this.read(sessionId, expected);
    if (typeof session === 'object') {
      this.sessions.delete(sessionId);
    }
    return session;
  }

  public read(
    sessionId: string,
    expected: Pick<AccountRegistrationSession, 'guildId' | 'requesterDiscordUserId'>,
  ): AccountRegistrationSession | 'expired' | 'mismatch' | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      return undefined;
    }
    if (session.expiresAt.getTime() <= this.clock.now().getTime()) {
      this.sessions.delete(sessionId);
      return 'expired';
    }
    if (
      session.guildId !== expected.guildId ||
      session.requesterDiscordUserId !== expected.requesterDiscordUserId
    ) {
      return 'mismatch';
    }
    return session;
  }

  public update(
    sessionId: string,
    expected: Pick<AccountRegistrationSession, 'guildId' | 'requesterDiscordUserId'>,
    update: Pick<
      AccountRegistrationSession,
      'associationKind' | 'linkedDiscordUserId' | 'username'
    >,
  ): AccountRegistrationSession | 'expired' | 'mismatch' | undefined {
    const session = this.read(sessionId, expected);
    if (typeof session !== 'object') {
      return session;
    }
    const updated = { ...session, ...update };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  private pruneExpired(): void {
    const now = this.clock.now().getTime();
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt.getTime() <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private evictOldestUntilBelowCapacity(): void {
    while (this.sessions.size >= this.maximumPendingSessions) {
      const oldestSessionId = this.sessions.keys().next().value;
      if (oldestSessionId === undefined) {
        return;
      }
      this.sessions.delete(oldestSessionId);
    }
  }
}

export type AccountRegistrationCommandResult =
  | { kind: 'username_required'; customId: string }
  | { kind: 'association_selection'; customId: string; message: string }
  | { kind: 'member_selection'; customId: string; message: string }
  | { kind: 'mode_selection'; customId: string; message: string; modeEmojis: GuildModeEmojis }
  | { kind: 'completed'; message: string }
  | { kind: 'expired'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'not_in_guild'; message: string };

export class AccountRegistrationCommandHandler {
  public constructor(private readonly services: AccountRegistrationCommandServices) {}

  public async start(context: GuildInteractionContext): Promise<AccountRegistrationCommandResult> {
    const authorization = await this.authorize(context);
    if (authorization === undefined) {
      return notInGuildRegistration();
    }
    const sessionId = this.services.sessions.create({
      expiresAt: new Date(
        this.services.clock.now().getTime() + REGISTRATION_INTERACTION_LIFETIME_MS,
      ),
      guildId: authorization.guildId,
      requesterDiscordUserId: authorization.requesterDiscordUserId,
    });
    return {
      kind: 'username_required',
      customId: encodeRegistrationInteraction('username', sessionId),
    };
  }

  public submitUsername(
    context: GuildInteractionContext,
    customId: string,
    username: string,
  ): AccountRegistrationCommandResult {
    const sessionId = decodeRegistrationInteraction(customId, 'username');
    const binding = toRegistrationBinding(context);
    if (sessionId === undefined || binding === undefined) {
      return invalidRegistrationInteraction(context);
    }
    const session = this.services.sessions.update(sessionId, binding, { username });
    if (typeof session !== 'object') {
      return registrationSessionFailure(session);
    }
    return {
      customId: encodeRegistrationInteraction('association', sessionId),
      kind: 'association_selection',
      message: 'Should this account be linked to a Discord member or added to the watchlist?',
    };
  }

  public async selectAssociation(
    context: GuildInteractionContext,
    customId: string,
    associationKind: string,
  ): Promise<AccountRegistrationCommandResult> {
    const sessionId = decodeRegistrationInteraction(customId, 'association');
    const authorization = await this.authorize(context);
    if (sessionId === undefined || authorization === undefined) {
      return invalidRegistrationInteraction(context);
    }
    if (associationKind !== 'linked' && associationKind !== 'watchlist') {
      return invalidRegistrationInteraction(context);
    }
    const session = this.services.sessions.update(
      sessionId,
      authorization,
      associationKind === 'linked' && !authorization.canManageAccounts
        ? { associationKind, linkedDiscordUserId: authorization.requesterDiscordUserId }
        : { associationKind },
    );
    if (typeof session !== 'object') {
      return registrationSessionFailure(session);
    }
    if (associationKind === 'linked' && authorization.canManageAccounts) {
      return {
        customId: encodeRegistrationInteraction('member', sessionId),
        kind: 'member_selection',
        message: 'Choose the Discord member to link this account to.',
      };
    }
    return this.modeSelection(sessionId, authorization.guildId);
  }

  public async selectLinkedMember(
    context: GuildInteractionContext,
    customId: string,
    linkedDiscordUserId: string,
  ): Promise<AccountRegistrationCommandResult> {
    const sessionId = decodeRegistrationInteraction(customId, 'member');
    const authorization = await this.authorize(context);
    if (sessionId === undefined || !authorization?.canManageAccounts) {
      return invalidRegistrationInteraction(context);
    }
    const existing = this.services.sessions.read(sessionId, authorization);
    if (typeof existing !== 'object') {
      return registrationSessionFailure(existing);
    }
    if (existing.associationKind !== 'linked' || linkedDiscordUserId.length === 0) {
      return invalidRegistrationInteraction(context);
    }
    this.services.sessions.update(sessionId, authorization, {
      associationKind: 'linked',
      linkedDiscordUserId,
    });
    return this.modeSelection(sessionId, authorization.guildId);
  }

  public async selectMode(
    context: GuildInteractionContext,
    customId: string,
    accountMode: string,
  ): Promise<AccountRegistrationCommandResult> {
    const sessionId = decodeRegistrationInteraction(customId, 'mode');
    const authorization = await this.authorize(context);
    if (sessionId === undefined || authorization === undefined || !isOsrsAccountMode(accountMode)) {
      return invalidRegistrationInteraction(context);
    }
    const session = this.services.sessions.consume(sessionId, authorization);
    if (typeof session !== 'object') {
      return registrationSessionFailure(session);
    }
    const association = toAssociation(session);
    if (session.username === undefined || association === undefined) {
      return invalidRegistrationInteraction(context);
    }
    return registrationResult(
      await this.services.accountRegistration.register({
        accountMode,
        association,
        canManageAccounts: authorization.canManageAccounts,
        guildId: authorization.guildId,
        requesterDiscordUserId: authorization.requesterDiscordUserId,
        username: session.username,
      }),
    );
  }

  private async authorize(
    context: GuildInteractionContext,
  ): Promise<
    | (GuildPermissionRequest & { canManageAccounts: boolean; requesterDiscordUserId: string })
    | undefined
  > {
    if (context.guildId === null) {
      return undefined;
    }
    const permissions = await this.services.permissions.evaluate({
      guildId: context.guildId,
      hasAdministratorPermission: context.hasAdministratorPermission,
      memberRoleIds: context.memberRoleIds,
    });
    return {
      ...context,
      canManageAccounts: permissions.canManageAccounts,
      guildId: context.guildId,
    };
  }

  private async modeSelection(
    sessionId: string,
    guildId: string,
  ): Promise<AccountRegistrationCommandResult> {
    return modeSelection(
      sessionId,
      await this.services.modeEmojiConfiguration.getModeEmojis(guildId),
    );
  }
}

export interface GuildModeEmojiProvider {
  getModeEmojis(guildId: string): Promise<GuildModeEmojis>;
}

export class DiscordAccountCommandAdapter {
  public constructor(
    private readonly removalHandler: AccountRemovalCommandHandler,
    private readonly registrationHandler?: AccountRegistrationCommandHandler,
  ) {}

  public async handle(
    interaction:
      | AutocompleteInteraction
      | ButtonInteraction
      | ChatInputCommandInteraction
      | ModalSubmitInteraction
      | StringSelectMenuInteraction
      | UserSelectMenuInteraction,
  ): Promise<void> {
    if (interaction.isAutocomplete()) {
      await this.handleAutocomplete(interaction);
      return;
    }
    if (interaction.isChatInputCommand()) {
      await this.handleChatInput(interaction);
      return;
    }
    if ('isModalSubmit' in interaction && interaction.isModalSubmit()) {
      await this.handleModalSubmit(interaction);
      return;
    }
    if ('isStringSelectMenu' in interaction && interaction.isStringSelectMenu()) {
      await this.handleStringSelectMenu(interaction);
      return;
    }
    if ('isUserSelectMenu' in interaction && interaction.isUserSelectMenu()) {
      await this.handleUserSelectMenu(interaction);
      return;
    }
    if (interaction.isButton()) {
      await this.handleButton(interaction);
    }
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (
      interaction.commandName !== ACCOUNT_COMMAND_NAME ||
      interaction.options.getSubcommand() !== REMOVE_SUBCOMMAND_NAME ||
      interaction.options.getFocused(true).name !== ACCOUNT_OPTION_NAME
    ) {
      return;
    }

    await interaction.respond(
      await this.removalHandler.autocomplete(
        toGuildInteractionContext(interaction),
        interaction.options.getFocused(),
      ),
    );
  }

  private async handleChatInput(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName !== ACCOUNT_COMMAND_NAME) {
      return;
    }
    if (interaction.options.getSubcommand() === REGISTER_SUBCOMMAND_NAME) {
      await this.handleRegistrationStart(interaction);
      return;
    }
    if (interaction.options.getSubcommand() !== REMOVE_SUBCOMMAND_NAME) {
      return;
    }

    const result = await this.removalHandler.requestRemoval(
      toGuildInteractionContext(interaction),
      interaction.options.getString(ACCOUNT_OPTION_NAME, true),
    );
    if (result.kind === 'confirmation_required') {
      await interaction.reply({
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(result.customId)
              .setLabel('Confirm removal')
              .setStyle(ButtonStyle.Danger),
          ),
        ],
        content: result.message,
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({ content: result.message, ephemeral: true });
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.customId.startsWith(`${REMOVAL_CONFIRMATION_PREFIX}:`)) {
      return;
    }

    await interaction.deferUpdate();
    const result = await this.removalHandler.confirmRemoval(
      toGuildInteractionContext(interaction),
      interaction.customId,
    );
    await interaction.editReply({ components: [], content: result.message });
  }

  private async handleRegistrationStart(interaction: ChatInputCommandInteraction): Promise<void> {
    if (this.registrationHandler === undefined) {
      return;
    }
    const result = await this.registrationHandler.start(toGuildInteractionContext(interaction));
    if (result.kind !== 'username_required') {
      await interaction.reply({ content: result.message, ephemeral: true });
      return;
    }
    await interaction.showModal(usernameModal(result.customId));
  }

  private async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    if (
      this.registrationHandler === undefined ||
      decodeRegistrationInteraction(interaction.customId, 'username') === undefined
    ) {
      return;
    }
    const result = this.registrationHandler.submitUsername(
      toGuildInteractionContext(interaction),
      interaction.customId,
      interaction.fields.getTextInputValue(USERNAME_INPUT_ID),
    );
    await replyRegistrationResult(interaction, result);
  }

  private async handleStringSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    if (this.registrationHandler === undefined) {
      return;
    }
    const value = interaction.values[0] ?? '';
    if (decodeRegistrationInteraction(interaction.customId, 'association') !== undefined) {
      await updateRegistrationResult(
        interaction,
        await this.registrationHandler.selectAssociation(
          toGuildInteractionContext(interaction),
          interaction.customId,
          value,
        ),
      );
      return;
    }
    if (decodeRegistrationInteraction(interaction.customId, 'mode') !== undefined) {
      await interaction.deferUpdate();
      await editRegistrationResult(
        interaction,
        await this.registrationHandler.selectMode(
          toGuildInteractionContext(interaction),
          interaction.customId,
          value,
        ),
      );
    }
  }

  private async handleUserSelectMenu(interaction: UserSelectMenuInteraction): Promise<void> {
    if (
      this.registrationHandler === undefined ||
      decodeRegistrationInteraction(interaction.customId, 'member') === undefined
    ) {
      return;
    }
    await updateRegistrationResult(
      interaction,
      await this.registrationHandler.selectLinkedMember(
        toGuildInteractionContext(interaction),
        interaction.customId,
        interaction.values[0] ?? '',
      ),
    );
  }
}

export function bindDiscordAccountCommandAdapter(
  client: Client,
  adapter: DiscordAccountCommandAdapter,
  reportUnexpectedError: (error: unknown) => void,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (
      interaction.isAutocomplete() ||
      interaction.isButton() ||
      interaction.isChatInputCommand() ||
      interaction.isModalSubmit() ||
      interaction.isStringSelectMenu() ||
      interaction.isUserSelectMenu()
    ) {
      void adapter.handle(interaction).catch(reportUnexpectedError);
    }
  });
}

export function createAccountRemovalCommandHandler(
  accountRepository: AccountRetrievalRepository & AccountRemovalRepository,
  permissions: GuildPermissionService,
): AccountRemovalCommandHandler {
  return new AccountRemovalCommandHandler({
    accountRetrieval: new AccountRetrievalService(accountRepository),
    accountRemoval: new AccountRemovalService(accountRepository),
    clock: systemClock,
    confirmations: new InMemoryDestructiveConfirmationStore(),
    permissions,
  });
}

export function createAccountRegistrationCommandHandler(
  accountRepository: AccountRegistrationRepository,
  accountModeValidator: AccountModeValidationService,
  configuration: GuildConfigurationService,
  permissions: GuildPermissionService,
): AccountRegistrationCommandHandler {
  return new AccountRegistrationCommandHandler({
    accountRegistration: new AccountRegistrationService(accountModeValidator, accountRepository),
    clock: systemClock,
    modeEmojiConfiguration: {
      getModeEmojis: async (guildId) => (await configuration.getOrCreate(guildId)).modeEmojis,
    },
    permissions,
    sessions: new InMemoryAccountRegistrationSessionStore(),
  });
}

function toGuildInteractionContext(
  interaction:
    | AutocompleteInteraction
    | ButtonInteraction
    | ChatInputCommandInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction
    | UserSelectMenuInteraction,
): GuildInteractionContext {
  return {
    guildId: interaction.guildId,
    hasAdministratorPermission:
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
    memberRoleIds: memberRoleIds(interaction),
    requesterDiscordUserId: interaction.user.id,
  };
}

function memberRoleIds(
  interaction:
    | AutocompleteInteraction
    | ButtonInteraction
    | ChatInputCommandInteraction
    | ModalSubmitInteraction
    | StringSelectMenuInteraction
    | UserSelectMenuInteraction,
): readonly string[] {
  const roles = interaction.member?.roles;
  if (roles === undefined) {
    return [];
  }

  return Array.isArray(roles) ? roles : [...roles.cache.keys()];
}

function encodeRemovalConfirmation(confirmationId: string): string {
  return `${REMOVAL_CONFIRMATION_PREFIX}:${confirmationId}`;
}

function decodeRemovalConfirmation(customId: string): string | undefined {
  if (!customId.startsWith(`${REMOVAL_CONFIRMATION_PREFIX}:`)) {
    return undefined;
  }

  const confirmationId = customId.slice(REMOVAL_CONFIRMATION_PREFIX.length + 1);
  if (confirmationId.length === 0 || confirmationId.includes(':')) {
    return undefined;
  }

  return confirmationId;
}

function toCommandResult(result: RemoveAccountResult): AccountRemovalCommandResult {
  switch (result.kind) {
    case 'removed':
      return {
        kind: 'removed',
        message:
          result.replacementDefaultAccount === undefined
            ? `Removed **${result.account.displayUsername}**.`
            : `Removed **${result.account.displayUsername}**. **${result.replacementDefaultAccount.displayUsername}** is now the default account.`,
      };
    case 'account_not_found':
      return accountNotFound();
    case 'forbidden':
      return forbidden();
  }
}

function accountNotFound(): AccountRemovalCommandResult {
  return { kind: 'account_not_found', message: 'That tracked account is no longer available.' };
}

function forbidden(): AccountRemovalCommandResult {
  return { kind: 'forbidden', message: 'You are not allowed to remove that account.' };
}

function confirmationExpired(): AccountRemovalCommandResult {
  return {
    kind: 'confirmation_expired',
    message: 'This removal confirmation has expired. Run `/account remove` again.',
  };
}

function notInGuild(): AccountRemovalCommandResult {
  return { kind: 'not_in_guild', message: 'This command can only be used in a Discord server.' };
}

function usernameModal(customId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Register an OSRS account')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(USERNAME_INPUT_ID)
          .setLabel('OSRS username')
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
}

async function replyRegistrationResult(
  interaction: ModalSubmitInteraction,
  result: AccountRegistrationCommandResult,
): Promise<void> {
  await interaction.reply(registrationResponse(result));
}

async function updateRegistrationResult(
  interaction: StringSelectMenuInteraction | UserSelectMenuInteraction,
  result: AccountRegistrationCommandResult,
): Promise<void> {
  await interaction.update(registrationResponse(result));
}

async function editRegistrationResult(
  interaction: StringSelectMenuInteraction,
  result: AccountRegistrationCommandResult,
): Promise<void> {
  await interaction.editReply(registrationResponse(result));
}

function registrationResponse(result: AccountRegistrationCommandResult) {
  switch (result.kind) {
    case 'association_selection':
      return {
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(result.customId)
              .setPlaceholder('Choose account association')
              .addOptions(
                { label: 'Linked account', value: 'linked' },
                { label: 'Watchlist account', value: 'watchlist' },
              ),
          ),
        ],
        content: result.message,
        ephemeral: true,
      };
    case 'member_selection':
      return {
        components: [
          new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
            new UserSelectMenuBuilder()
              .setCustomId(result.customId)
              .setPlaceholder('Choose a Discord member')
              .setMaxValues(1)
              .setMinValues(1),
          ),
        ],
        content: result.message,
        ephemeral: true,
      };
    case 'mode_selection':
      return {
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(result.customId)
              .setPlaceholder('Choose game mode')
              .addOptions(
                OSRS_ACCOUNT_MODES.map((accountMode) => ({
                  label: accountModeLabel(accountMode),
                  value: accountMode,
                  ...(result.modeEmojis[accountMode] === undefined
                    ? {}
                    : { emoji: result.modeEmojis[accountMode] }),
                })),
              ),
          ),
        ],
        content: result.message,
        ephemeral: true,
      };
    case 'username_required':
      return {
        components: [],
        content: 'Run `/account register` again to enter an OSRS username.',
        ephemeral: true,
      };
    default:
      return { components: [], content: result.message, ephemeral: true };
  }
}

function modeSelection(
  sessionId: string,
  modeEmojis: GuildModeEmojis,
): AccountRegistrationCommandResult {
  return {
    customId: encodeRegistrationInteraction('mode', sessionId),
    kind: 'mode_selection',
    message: "Choose this account's game mode.",
    modeEmojis,
  };
}

function registrationResult(result: AccountRegistrationResult): AccountRegistrationCommandResult {
  switch (result.kind) {
    case 'registered':
      return {
        kind: 'completed',
        message: `Registered **${result.account.displayUsername}** as ${indefiniteArticle(result.account.accountMode)} ${accountModeLabel(result.account.accountMode)} ${result.account.association.type} account.`,
      };
    case 'forbidden':
      return registrationForbidden();
    case 'invalid_username':
      return { kind: 'completed', message: 'That OSRS username is invalid.' };
    case 'username_taken':
      return {
        kind: 'completed',
        message: 'That OSRS username is already tracked in this server.',
      };
    case 'account_limit_reached':
      return {
        kind: 'completed',
        message: 'That member already manages the maximum of 10 tracked accounts.',
      };
    case 'hiscores_failure':
      return { kind: 'completed', message: hiscoresFailureMessage(result.failure.kind) };
  }
}

function hiscoresFailureMessage(
  kind:
    | 'not_found'
    | 'mode_incompatible'
    | 'timeout'
    | 'temporary_upstream_failure'
    | 'malformed_response'
    | 'incomplete_response',
): string {
  switch (kind) {
    case 'not_found':
      return 'That OSRS account could not be found for the selected mode.';
    case 'mode_incompatible':
      return 'That OSRS account is not compatible with the selected mode.';
    case 'timeout':
      return 'The OSRS Hiscores request timed out. Please try again.';
    case 'temporary_upstream_failure':
      return 'The OSRS Hiscores service is temporarily unavailable. Please try again.';
    case 'malformed_response':
    case 'incomplete_response':
      return 'The OSRS Hiscores response could not be validated. Please try again.';
    default:
      return 'The OSRS Hiscores request failed. Please try again.';
  }
}

function accountModeLabel(accountMode: OsrsAccountMode): string {
  return {
    group_ironman: 'Group Ironman',
    hardcore_group_ironman: 'Hardcore Group Ironman',
    hardcore_ironman: 'Hardcore Ironman',
    ironman: 'Ironman',
    main: 'Main',
    ultimate_ironman: 'Ultimate Ironman',
  }[accountMode];
}

function indefiniteArticle(accountMode: OsrsAccountMode): 'a' | 'an' {
  return accountMode === 'ironman' || accountMode === 'ultimate_ironman' ? 'an' : 'a';
}

function encodeRegistrationInteraction(
  kind: 'username' | 'association' | 'member' | 'mode',
  sessionId: string,
): string {
  return `${REGISTRATION_INTERACTION_PREFIX}:${kind}:${sessionId}`;
}

function decodeRegistrationInteraction(
  customId: string,
  expectedKind: 'username' | 'association' | 'member' | 'mode',
): string | undefined {
  const prefix = `${REGISTRATION_INTERACTION_PREFIX}:${expectedKind}:`;
  if (!customId.startsWith(prefix)) {
    return undefined;
  }
  const sessionId = customId.slice(prefix.length);
  return sessionId.length > 0 && !sessionId.includes(':') ? sessionId : undefined;
}

function toRegistrationBinding(
  context: GuildInteractionContext,
): Pick<AccountRegistrationSession, 'guildId' | 'requesterDiscordUserId'> | undefined {
  return context.guildId === null
    ? undefined
    : { guildId: context.guildId, requesterDiscordUserId: context.requesterDiscordUserId };
}

function invalidRegistrationInteraction(
  context: GuildInteractionContext,
): AccountRegistrationCommandResult {
  return context.guildId === null ? notInGuildRegistration() : registrationForbidden();
}

function registrationSessionFailure(
  failure: 'expired' | 'mismatch' | undefined,
): AccountRegistrationCommandResult {
  return failure === 'expired'
    ? {
        kind: 'expired',
        message: 'This registration flow has expired. Run `/account register` again.',
      }
    : registrationForbidden();
}

function registrationForbidden(): AccountRegistrationCommandResult {
  return { kind: 'forbidden', message: 'You are not allowed to use this registration flow.' };
}

function notInGuildRegistration(): AccountRegistrationCommandResult {
  return { kind: 'not_in_guild', message: 'This command can only be used in a Discord server.' };
}

function isOsrsAccountMode(value: string): value is OsrsAccountMode {
  return (OSRS_ACCOUNT_MODES as readonly string[]).includes(value);
}

function toAssociation(session: AccountRegistrationSession): AccountAssociation | undefined {
  if (session.associationKind === 'watchlist') {
    return { type: 'watchlist' };
  }
  return session.associationKind === 'linked' && session.linkedDiscordUserId !== undefined
    ? { discordUserId: session.linkedDiscordUserId, type: 'linked' }
    : undefined;
}

const systemClock: Clock = { now: () => new Date() };
