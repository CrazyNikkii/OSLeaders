import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  PermissionFlagsBits,
  Routes,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type REST,
} from 'discord.js';
import { randomUUID } from 'node:crypto';

import {
  AccountRetrievalService,
  type AccountRetrievalRepository,
} from '../../features/accounts/account-retrieval.js';
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

const ACCOUNT_COMMAND_NAME = 'account';
const REMOVE_SUBCOMMAND_NAME = 'remove';
const ACCOUNT_OPTION_NAME = 'account';
const REMOVAL_CONFIRMATION_PREFIX = 'osleaders:account-remove';
const MAX_AUTOCOMPLETE_CHOICES = 25;
const MAX_PENDING_DESTRUCTIVE_CONFIRMATIONS = 1_000;
const REMOVAL_CONFIRMATION_LIFETIME_MS = 5 * 60 * 1000;

export const accountCommandDefinitions = [
  new SlashCommandBuilder()
    .setName(ACCOUNT_COMMAND_NAME)
    .setDescription('Manage tracked OSRS accounts.')
    .setDMPermission(false)
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

export class DiscordAccountCommandAdapter {
  public constructor(private readonly handler: AccountRemovalCommandHandler) {}

  public async handle(
    interaction: AutocompleteInteraction | ButtonInteraction | ChatInputCommandInteraction,
  ): Promise<void> {
    if (interaction.isAutocomplete()) {
      await this.handleAutocomplete(interaction);
      return;
    }
    if (interaction.isChatInputCommand()) {
      await this.handleChatInput(interaction);
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
      await this.handler.autocomplete(
        toGuildInteractionContext(interaction),
        interaction.options.getFocused(),
      ),
    );
  }

  private async handleChatInput(interaction: ChatInputCommandInteraction): Promise<void> {
    if (
      interaction.commandName !== ACCOUNT_COMMAND_NAME ||
      interaction.options.getSubcommand() !== REMOVE_SUBCOMMAND_NAME
    ) {
      return;
    }

    const result = await this.handler.requestRemoval(
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
    const result = await this.handler.confirmRemoval(
      toGuildInteractionContext(interaction),
      interaction.customId,
    );
    await interaction.editReply({ components: [], content: result.message });
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
      interaction.isChatInputCommand()
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

function toGuildInteractionContext(
  interaction: AutocompleteInteraction | ButtonInteraction | ChatInputCommandInteraction,
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
  interaction: AutocompleteInteraction | ButtonInteraction | ChatInputCommandInteraction,
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

const systemClock: Clock = { now: () => new Date() };
