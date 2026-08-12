import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  MessageFlags,
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
  type Interaction,
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
  DefaultAccountSelectionService,
  type DefaultAccountSelectionRepository,
} from '../../features/accounts/select-default-account.js';
import {
  AccountRenameService,
  canRename,
  type AccountRenameRepository,
  type RenameAccountResult,
} from '../../features/accounts/rename-account.js';
import {
  AccountModeChangeService,
  canChangeMode,
  type AccountModeChangeRepository,
  type ChangeAccountModeResult,
} from '../../features/accounts/change-account-mode.js';
import {
  GuildPermissionService,
  type GuildPermissionRequest,
  type GuildPermissions,
} from '../../features/guild-configuration/guild-permission-service.js';
import {
  GuildConfigurationService,
  type GuildModeEmojis,
} from '../../features/guild-configuration/guild-configuration-service.js';
import { shouldDeliverAdministrativeAuditEvent } from '../../features/audit/administrative-audit-policy.js';
import type { AuditService } from '../../features/audit/audit-service.js';
import { OSLEADERS_SUCCESS_EMBED_COLOR } from './discord-embed-presentation.js';
import {
  OSRS_ACCOUNT_MODES,
  type OsrsAccountMode,
} from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';
import type { StructuredLogEntry } from '../../shared/structured-logging.js';

const ACCOUNT_COMMAND_NAME = 'account';
const REGISTER_SUBCOMMAND_NAME = 'register';
const REMOVE_SUBCOMMAND_NAME = 'remove';
const DEFAULT_SUBCOMMAND_NAME = 'default';
const RENAME_SUBCOMMAND_NAME = 'rename';
const MODE_SUBCOMMAND_NAME = 'mode';
const ACCOUNT_OPTION_NAME = 'account';
const REMOVAL_CONFIRMATION_PREFIX = 'osleaders:account-remove';
const ACTIVE_COMPETITION_RENAME_CONFIRMATION_PREFIX = 'osleaders:account-rename-confirm';
const MAX_AUTOCOMPLETE_CHOICES = 25;
const MAX_PENDING_DESTRUCTIVE_CONFIRMATIONS = 1_000;
const REMOVAL_CONFIRMATION_LIFETIME_MS = 5 * 60 * 1000;
const REGISTRATION_INTERACTION_PREFIX = 'osleaders:account-register';
const REGISTRATION_INTERACTION_LIFETIME_MS = 5 * 60 * 1000;
const USERNAME_INPUT_ID = 'username';
const RENAME_INTERACTION_PREFIX = 'osleaders:account-rename';
const MODE_INTERACTION_PREFIX = 'osleaders:account-mode';

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
    .addSubcommand((subcommand) =>
      subcommand
        .setName(DEFAULT_SUBCOMMAND_NAME)
        .setDescription('Choose a linked account as the default account.')
        .addStringOption((option) =>
          option
            .setName(ACCOUNT_OPTION_NAME)
            .setDescription('The linked account to make default.')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName(RENAME_SUBCOMMAND_NAME)
        .setDescription('Rename a tracked OSRS account after an RSN change.')
        .addStringOption((option) =>
          option
            .setName(ACCOUNT_OPTION_NAME)
            .setDescription('The account to rename.')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName(MODE_SUBCOMMAND_NAME)
        .setDescription('Change a tracked OSRS account game mode after validation.')
        .addStringOption((option) =>
          option
            .setName(ACCOUNT_OPTION_NAME)
            .setDescription('The account whose game mode should change.')
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
  action: 'account_remove' | 'active_competition_rename';
  expiresAt: Date;
  guildId: string;
  requesterDiscordUserId: string;
  username?: string;
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
  | { kind: 'active_competition_locked'; message: string }
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

export interface AccountDefaultSelectionCommandServices {
  accountRetrieval: Pick<AccountRetrievalService, 'listForGuild'>;
  defaultAccountSelection: Pick<DefaultAccountSelectionService, 'select'>;
  permissions: AccountCommandPermissionEvaluator;
}

export type AccountDefaultSelectionCommandResult =
  | { kind: 'selected'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'account_not_found'; message: string }
  | { kind: 'not_in_guild'; message: string };

export class AccountDefaultSelectionCommandHandler {
  public constructor(private readonly services: AccountDefaultSelectionCommandServices) {}

  public async select(
    context: GuildInteractionContext,
    accountId: string,
  ): Promise<AccountDefaultSelectionCommandResult> {
    const authorization = await this.authorize(context);
    if (authorization === undefined) {
      return notInGuildDefaultSelection();
    }

    const result = await this.services.defaultAccountSelection.select({
      accountId,
      canManageAccounts: authorization.canManageAccounts,
      guildId: authorization.guildId,
      requesterDiscordUserId: authorization.requesterDiscordUserId,
    });
    switch (result.kind) {
      case 'selected':
        return {
          kind: 'selected',
          message: `**${result.account.displayUsername}** is now the default account.`,
        };
      case 'forbidden':
        return {
          kind: 'forbidden',
          message: 'You are not allowed to select that account as the default.',
        };
      case 'account_not_found':
        return {
          kind: 'account_not_found',
          message: 'That linked account is no longer available.',
        };
    }
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
      .filter(
        (account) =>
          account.association.type === 'linked' &&
          (authorization.canManageAccounts ||
            account.association.discordUserId === authorization.requesterDiscordUserId),
      )
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

export interface AccountRenameCommandServices {
  accountRetrieval: Pick<AccountRetrievalService, 'listForGuild'>;
  accountRename: Pick<AccountRenameService, 'rename'>;
  audit: Pick<AuditService, 'record'>;
  clock: Clock;
  confirmations: DestructiveConfirmationStore;
  permissions: AccountCommandPermissionEvaluator;
}

export type AccountRenameCommandResult =
  | { kind: 'renamed'; message: string; auditEntry: StructuredLogEntry }
  | { kind: 'confirmation_required'; customId: string; message: string }
  | { kind: 'confirmation_expired'; message: string }
  | { kind: 'active_competition_locked'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'account_not_found'; message: string }
  | { kind: 'invalid_username'; message: string }
  | { kind: 'username_taken'; message: string }
  | { kind: 'hiscores_failure'; message: string }
  | { kind: 'not_in_guild'; message: string };

export class AccountRenameCommandHandler {
  public constructor(private readonly services: AccountRenameCommandServices) {}

  public async rename(
    context: GuildInteractionContext,
    accountId: string,
    username: string,
    activeCompetitionRenameConfirmed = false,
  ): Promise<AccountRenameCommandResult> {
    const authorization = await this.authorize(context);
    if (authorization === undefined) {
      return {
        kind: 'not_in_guild',
        message: 'This command can only be used in a Discord server.',
      };
    }

    const result = await this.services.accountRename.rename({
      accountId,
      activeCompetitionRenameConfirmed,
      canManageAccounts: authorization.canManageAccounts,
      guildId: authorization.guildId,
      requesterDiscordUserId: authorization.requesterDiscordUserId,
      username,
    });
    if (result.kind === 'active_competition_confirmation_required') {
      return {
        customId: encodeActiveCompetitionRenameConfirmation(
          this.services.confirmations.create({
            accountId,
            action: 'active_competition_rename',
            expiresAt: new Date(
              this.services.clock.now().getTime() + REMOVAL_CONFIRMATION_LIFETIME_MS,
            ),
            guildId: authorization.guildId,
            requesterDiscordUserId: authorization.requesterDiscordUserId,
            username,
          }),
        ),
        kind: 'confirmation_required',
        message:
          'This account contributes to an unresolved competition. Confirm the validated RSN change.',
      };
    }
    return renameCommandResult(result, (event) => this.services.audit.record(event), {
      guildId: authorization.guildId,
      requesterDiscordUserId: authorization.requesterDiscordUserId,
    });
  }

  public async confirmActiveCompetitionRename(
    context: GuildInteractionContext,
    customId: string,
  ): Promise<AccountRenameCommandResult> {
    const authorization = await this.authorize(context);
    if (authorization === undefined) {
      return {
        kind: 'not_in_guild',
        message: 'This command can only be used in a Discord server.',
      };
    }
    const confirmationId = decodeActiveCompetitionRenameConfirmation(customId);
    if (confirmationId === undefined) {
      return { kind: 'forbidden', message: 'You are not allowed to rename that account.' };
    }
    const confirmation = this.services.confirmations.consume(confirmationId, {
      action: 'active_competition_rename',
      guildId: authorization.guildId,
      requesterDiscordUserId: authorization.requesterDiscordUserId,
    });
    if (confirmation === 'expired') {
      return {
        kind: 'confirmation_expired',
        message: 'This rename confirmation has expired. Run `/account rename` again.',
      };
    }
    if (confirmation === 'mismatch' || confirmation?.username === undefined) {
      return { kind: 'forbidden', message: 'You are not allowed to rename that account.' };
    }
    return this.rename(context, confirmation.accountId, confirmation.username, true);
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
    return (await this.services.accountRetrieval.listForGuild(authorization.guildId))
      .filter((account) =>
        canRename(account, { ...authorization, accountId: account.id, username: '' }),
      )
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

export interface AccountModeCommandServices {
  accountModeChange: Pick<AccountModeChangeService, 'change'>;
  accountRetrieval: Pick<AccountRetrievalService, 'listForGuild'>;
  audit: Pick<AuditService, 'record'>;
  permissions: AccountCommandPermissionEvaluator;
}

export type AccountModeCommandResult =
  | { kind: 'mode_changed'; message: string; auditEntry: StructuredLogEntry }
  | { kind: 'active_competition_locked'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'account_not_found'; message: string }
  | { kind: 'hiscores_failure'; message: string }
  | { kind: 'not_in_guild'; message: string };

export class AccountModeCommandHandler {
  public constructor(private readonly services: AccountModeCommandServices) {}

  public async change(
    context: GuildInteractionContext,
    accountId: string,
    accountMode: OsrsAccountMode,
  ): Promise<AccountModeCommandResult> {
    const authorization = await this.authorize(context);
    if (authorization === undefined) {
      return {
        kind: 'not_in_guild',
        message: 'This command can only be used in a Discord server.',
      };
    }
    const result = await this.services.accountModeChange.change({
      accountId,
      accountMode,
      canManageAccounts: authorization.canManageAccounts,
      guildId: authorization.guildId,
      requesterDiscordUserId: authorization.requesterDiscordUserId,
    });
    return modeCommandResult(result, (event) => this.services.audit.record(event), {
      guildId: authorization.guildId,
      requesterDiscordUserId: authorization.requesterDiscordUserId,
    });
  }

  public async autocomplete(
    context: GuildInteractionContext,
    query: string,
  ): Promise<{ name: string; value: string }[]> {
    const authorization = await this.authorize(context);
    if (authorization === undefined) return [];
    const normalizedQuery = query.trim().toLocaleLowerCase('en-US');
    return (await this.services.accountRetrieval.listForGuild(authorization.guildId))
      .filter((account) =>
        canChangeMode(account, {
          ...authorization,
          accountId: account.id,
          accountMode: account.accountMode,
        }),
      )
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
    if (context.guildId === null) return undefined;
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
  | { kind: 'completed'; message: string; announcement?: string }
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

export interface RegistrationAnnouncementPublisher {
  publish(interaction: StringSelectMenuInteraction, message: string): Promise<void>;
}

export class DiscordRegistrationAnnouncementPublisher implements RegistrationAnnouncementPublisher {
  public async publish(interaction: StringSelectMenuInteraction, message: string): Promise<void> {
    const channel = interaction.channel;
    if (!channel?.isSendable()) {
      throw new Error('The registration channel is not available for public announcements.');
    }
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(OSLEADERS_SUCCESS_EMBED_COLOR)
          .setDescription(message)
          .setFooter({ text: 'OSLeaders' })
          .setTitle('Account registered'),
      ],
    });
  }
}

export interface RegistrationAdministrativeLogPublisher {
  publish(interaction: StringSelectMenuInteraction, message: string): Promise<void>;
}

export class DiscordRegistrationAdministrativeLogPublisher implements RegistrationAdministrativeLogPublisher {
  public constructor(
    private readonly configuration: Pick<GuildConfigurationService, 'getOrCreate'>,
  ) {}

  public async publish(interaction: StringSelectMenuInteraction, message: string): Promise<void> {
    if (interaction.guildId === null) {
      return;
    }

    const configuration = await this.configuration.getOrCreate(interaction.guildId);
    if (
      configuration.administrativeLogChannelId === null ||
      !shouldDeliverAdministrativeAuditEvent(
        {
          guildId: interaction.guildId,
          occurredAt: new Date(),
          operation: 'account.register',
          severity: 'info',
          type: 'account-registration',
        },
        configuration.administrativeLogMode,
      )
    ) {
      return;
    }

    const channel = await interaction.guild?.channels.fetch(
      configuration.administrativeLogChannelId,
    );
    if (!channel?.isSendable()) {
      throw new Error('The configured administrative log channel is not available.');
    }
    await channel.send({ content: message });
  }
}

class NoopRegistrationAdministrativeLogPublisher implements RegistrationAdministrativeLogPublisher {
  public publish(): Promise<void> {
    return Promise.resolve();
  }
}

export interface RenameAdministrativeLogPublisher {
  publish(
    interaction: ModalSubmitInteraction | ButtonInteraction,
    auditEntry: StructuredLogEntry,
  ): Promise<void>;
}

export interface ModeAdministrativeLogPublisher {
  publish(interaction: StringSelectMenuInteraction, auditEntry: StructuredLogEntry): Promise<void>;
}

export class DiscordModeAdministrativeLogPublisher implements ModeAdministrativeLogPublisher {
  public constructor(
    private readonly configuration: Pick<GuildConfigurationService, 'getOrCreate'>,
  ) {}

  public async publish(
    interaction: StringSelectMenuInteraction,
    auditEntry: StructuredLogEntry,
  ): Promise<void> {
    if (interaction.guildId === null) return;
    const configuration = await this.configuration.getOrCreate(interaction.guildId);
    if (
      configuration.administrativeLogChannelId === null ||
      !shouldDeliverAdministrativeAuditEvent(
        {
          guildId: interaction.guildId,
          occurredAt: new Date(),
          operation: auditEntry.operation,
          severity: auditEntry.severity,
          type: 'account-edit-or-deletion',
        },
        configuration.administrativeLogMode,
      )
    )
      return;
    const channel = await interaction.guild?.channels.fetch(
      configuration.administrativeLogChannelId,
    );
    if (!channel?.isSendable()) {
      throw new Error('The configured administrative log channel is not available.');
    }
    await channel.send({ content: renderModeAuditEntry(auditEntry) });
  }
}

class NoopModeAdministrativeLogPublisher implements ModeAdministrativeLogPublisher {
  public publish(): Promise<void> {
    return Promise.resolve();
  }
}

export class DiscordRenameAdministrativeLogPublisher implements RenameAdministrativeLogPublisher {
  public constructor(
    private readonly configuration: Pick<GuildConfigurationService, 'getOrCreate'>,
  ) {}

  public async publish(
    interaction: ModalSubmitInteraction,
    auditEntry: StructuredLogEntry,
  ): Promise<void> {
    if (interaction.guildId === null) {
      return;
    }

    const configuration = await this.configuration.getOrCreate(interaction.guildId);
    if (
      configuration.administrativeLogChannelId === null ||
      !shouldDeliverAdministrativeAuditEvent(
        {
          guildId: interaction.guildId,
          occurredAt: new Date(),
          operation: auditEntry.operation,
          severity: auditEntry.severity,
          type: 'account-edit-or-deletion',
        },
        configuration.administrativeLogMode,
      )
    ) {
      return;
    }

    const channel = await interaction.guild?.channels.fetch(
      configuration.administrativeLogChannelId,
    );
    if (!channel?.isSendable()) {
      throw new Error('The configured administrative log channel is not available.');
    }
    await channel.send({ content: renderRenameAuditEntry(auditEntry) });
  }
}

class NoopRenameAdministrativeLogPublisher implements RenameAdministrativeLogPublisher {
  public publish(): Promise<void> {
    return Promise.resolve();
  }
}

export class DiscordAccountCommandAdapter {
  private readonly registrationAdministrativeLogPublisher: RegistrationAdministrativeLogPublisher;
  private readonly renameAdministrativeLogPublisher: RenameAdministrativeLogPublisher;
  private readonly modeAdministrativeLogPublisher: ModeAdministrativeLogPublisher;

  public constructor(
    private readonly removalHandler: AccountRemovalCommandHandler,
    private readonly defaultSelectionHandler: AccountDefaultSelectionCommandHandler,
    private readonly registrationHandler?: AccountRegistrationCommandHandler,
    private readonly registrationAnnouncementPublisher: RegistrationAnnouncementPublisher = new DiscordRegistrationAnnouncementPublisher(),
    registrationAdministrativeLogPublisher?: RegistrationAdministrativeLogPublisher,
    private readonly renameHandler?: AccountRenameCommandHandler,
    renameAdministrativeLogPublisher?: RenameAdministrativeLogPublisher,
    private readonly modeHandler?: AccountModeCommandHandler,
    modeAdministrativeLogPublisher?: ModeAdministrativeLogPublisher,
  ) {
    if (registrationHandler !== undefined && registrationAdministrativeLogPublisher === undefined) {
      throw new Error('Registration support requires an administrative log publisher.');
    }
    this.registrationAdministrativeLogPublisher =
      registrationAdministrativeLogPublisher ?? new NoopRegistrationAdministrativeLogPublisher();
    if (renameHandler !== undefined && renameAdministrativeLogPublisher === undefined) {
      throw new Error('Rename support requires an administrative log publisher.');
    }
    this.renameAdministrativeLogPublisher =
      renameAdministrativeLogPublisher ?? new NoopRenameAdministrativeLogPublisher();
    if (modeHandler !== undefined && modeAdministrativeLogPublisher === undefined) {
      throw new Error('Mode-change support requires an administrative log publisher.');
    }
    this.modeAdministrativeLogPublisher =
      modeAdministrativeLogPublisher ?? new NoopModeAdministrativeLogPublisher();
  }

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
      interaction.options.getFocused(true).name !== ACCOUNT_OPTION_NAME
    ) {
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === DEFAULT_SUBCOMMAND_NAME) {
      await interaction.respond(
        await this.defaultSelectionHandler.autocomplete(
          toGuildInteractionContext(interaction),
          interaction.options.getFocused(),
        ),
      );
      return;
    }
    if (subcommand === RENAME_SUBCOMMAND_NAME && this.renameHandler !== undefined) {
      await interaction.respond(
        await this.renameHandler.autocomplete(
          toGuildInteractionContext(interaction),
          interaction.options.getFocused(),
        ),
      );
      return;
    }
    if (subcommand === MODE_SUBCOMMAND_NAME && this.modeHandler !== undefined) {
      await interaction.respond(
        await this.modeHandler.autocomplete(
          toGuildInteractionContext(interaction),
          interaction.options.getFocused(),
        ),
      );
      return;
    }
    if (subcommand !== REMOVE_SUBCOMMAND_NAME) {
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
    if (interaction.options.getSubcommand() === DEFAULT_SUBCOMMAND_NAME) {
      await this.handleDefaultSelection(interaction);
      return;
    }
    if (interaction.options.getSubcommand() === RENAME_SUBCOMMAND_NAME) {
      await this.handleRenameStart(interaction);
      return;
    }
    if (interaction.options.getSubcommand() === MODE_SUBCOMMAND_NAME) {
      await this.handleModeStart(interaction);
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
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
  }

  private async handleDefaultSelection(interaction: ChatInputCommandInteraction): Promise<void> {
    const result = await this.defaultSelectionHandler.select(
      toGuildInteractionContext(interaction),
      interaction.options.getString(ACCOUNT_OPTION_NAME, true),
    );
    await interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
  }

  private async handleRenameStart(interaction: ChatInputCommandInteraction): Promise<void> {
    if (this.renameHandler === undefined) {
      return;
    }
    await interaction.showModal(
      renameModal(
        encodeRenameInteraction(interaction.options.getString(ACCOUNT_OPTION_NAME, true)),
      ),
    );
  }

  private async handleModeStart(interaction: ChatInputCommandInteraction): Promise<void> {
    if (this.modeHandler === undefined) return;
    await interaction.reply({
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(
              encodeModeInteraction(interaction.options.getString(ACCOUNT_OPTION_NAME, true)),
            )
            .setPlaceholder('Choose game mode')
            .addOptions(
              OSRS_ACCOUNT_MODES.map((mode) => ({ label: accountModeLabel(mode), value: mode })),
            ),
        ),
      ],
      content: 'Choose the new game mode. The account will be validated before it is changed.',
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    if (interaction.customId.startsWith(`${REMOVAL_CONFIRMATION_PREFIX}:`)) {
      await interaction.deferUpdate();
      const result = await this.removalHandler.confirmRemoval(
        toGuildInteractionContext(interaction),
        interaction.customId,
      );
      await interaction.editReply({ components: [], content: result.message });
      return;
    }
    if (
      !interaction.customId.startsWith(`${ACTIVE_COMPETITION_RENAME_CONFIRMATION_PREFIX}:`) ||
      this.renameHandler === undefined
    ) {
      return;
    }
    await interaction.deferUpdate();
    const result = await this.renameHandler.confirmActiveCompetitionRename(
      toGuildInteractionContext(interaction),
      interaction.customId,
    );
    await interaction.editReply({ components: [], content: result.message });
    if (result.kind === 'renamed') {
      try {
        await this.renameAdministrativeLogPublisher.publish(interaction, result.auditEntry);
      } catch {
        // Administrative delivery is an optional side effect and must not undo a rename.
      }
    }
  }

  private async handleRegistrationStart(interaction: ChatInputCommandInteraction): Promise<void> {
    if (this.registrationHandler === undefined) {
      return;
    }
    const result = await this.registrationHandler.start(toGuildInteractionContext(interaction));
    if (result.kind !== 'username_required') {
      await interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(usernameModal(result.customId));
  }

  private async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const renameAccountId = decodeRenameInteraction(interaction.customId);
    if (renameAccountId !== undefined && this.renameHandler !== undefined) {
      const result = await this.renameHandler.rename(
        toGuildInteractionContext(interaction),
        renameAccountId,
        interaction.fields.getTextInputValue(USERNAME_INPUT_ID),
      );
      if (result.kind === 'confirmation_required') {
        await interaction.reply({
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(result.customId)
                .setLabel('Confirm RSN change')
                .setStyle(ButtonStyle.Danger),
            ),
          ],
          content: result.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
      if (result.kind === 'renamed') {
        try {
          await this.renameAdministrativeLogPublisher.publish(interaction, result.auditEntry);
        } catch {
          // Administrative delivery is an optional side effect and must not undo a rename.
        }
      }
      return;
    }
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
    const value = interaction.values[0] ?? '';
    const modeAccountId = decodeModeInteraction(interaction.customId);
    if (modeAccountId !== undefined && this.modeHandler !== undefined) {
      if (!isOsrsAccountMode(value)) {
        await interaction.reply({
          content: 'That account mode is invalid.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferUpdate();
      const result = await this.modeHandler.change(
        toGuildInteractionContext(interaction),
        modeAccountId,
        value,
      );
      await interaction.editReply({ components: [], content: result.message });
      if (result.kind === 'mode_changed') {
        try {
          await this.modeAdministrativeLogPublisher.publish(interaction, result.auditEntry);
        } catch {
          // Administrative delivery is an optional side effect and must not undo a mode change.
        }
      }
      return;
    }
    if (this.registrationHandler === undefined) return;
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
      const result = await this.registrationHandler.selectMode(
        toGuildInteractionContext(interaction),
        interaction.customId,
        value,
      );
      await editRegistrationResult(interaction, result);
      if (result.kind === 'completed' && result.announcement !== undefined) {
        try {
          await this.registrationAnnouncementPublisher.publish(interaction, result.announcement);
        } catch {
          await interaction.editReply({
            components: [],
            content: `${result.message} The public registration announcement could not be posted.`,
          });
        }
        try {
          await this.registrationAdministrativeLogPublisher.publish(
            interaction,
            result.announcement,
          );
        } catch {
          // Administrative delivery is an optional side effect and must not undo registration.
        }
      }
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
  shouldHandleInteraction: (interaction: Interaction) => boolean = () => true,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!shouldHandleInteraction(interaction)) {
      return;
    }
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

export function createAccountDefaultSelectionCommandHandler(
  accountRepository: AccountRetrievalRepository & DefaultAccountSelectionRepository,
  permissions: AccountCommandPermissionEvaluator,
): AccountDefaultSelectionCommandHandler {
  return new AccountDefaultSelectionCommandHandler({
    accountRetrieval: new AccountRetrievalService(accountRepository),
    defaultAccountSelection: new DefaultAccountSelectionService(
      accountRepository,
      accountRepository,
    ),
    permissions,
  });
}

export function createAccountRenameCommandHandler(
  accountRepository: AccountRetrievalRepository & AccountRenameRepository,
  accountModeValidator: AccountModeValidationService,
  audit: Pick<AuditService, 'record'>,
  permissions: AccountCommandPermissionEvaluator,
): AccountRenameCommandHandler {
  return new AccountRenameCommandHandler({
    accountRetrieval: new AccountRetrievalService(accountRepository),
    accountRename: new AccountRenameService(
      accountModeValidator,
      accountRepository,
      accountRepository,
    ),
    audit,
    clock: systemClock,
    confirmations: new InMemoryDestructiveConfirmationStore(),
    permissions,
  });
}

export function createAccountModeCommandHandler(
  accountRepository: AccountRetrievalRepository & AccountModeChangeRepository,
  accountModeValidator: AccountModeValidationService,
  audit: Pick<AuditService, 'record'>,
  permissions: AccountCommandPermissionEvaluator,
): AccountModeCommandHandler {
  return new AccountModeCommandHandler({
    accountModeChange: new AccountModeChangeService(
      accountModeValidator,
      accountRepository,
      accountRepository,
    ),
    accountRetrieval: new AccountRetrievalService(accountRepository),
    audit,
    permissions,
  });
}

export function createDiscordAccountCommandAdapter(
  removalHandler: AccountRemovalCommandHandler,
  defaultSelectionHandler: AccountDefaultSelectionCommandHandler,
  registrationHandler: AccountRegistrationCommandHandler,
  renameHandler: AccountRenameCommandHandler,
  modeHandler: AccountModeCommandHandler,
  configuration: Pick<GuildConfigurationService, 'getOrCreate'>,
): DiscordAccountCommandAdapter {
  return new DiscordAccountCommandAdapter(
    removalHandler,
    defaultSelectionHandler,
    registrationHandler,
    new DiscordRegistrationAnnouncementPublisher(),
    new DiscordRegistrationAdministrativeLogPublisher(configuration),
    renameHandler,
    new DiscordRenameAdministrativeLogPublisher(configuration),
    modeHandler,
    new DiscordModeAdministrativeLogPublisher(configuration),
  );
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

function encodeActiveCompetitionRenameConfirmation(confirmationId: string): string {
  return `${ACTIVE_COMPETITION_RENAME_CONFIRMATION_PREFIX}:${confirmationId}`;
}

function decodeActiveCompetitionRenameConfirmation(customId: string): string | undefined {
  const prefix = `${ACTIVE_COMPETITION_RENAME_CONFIRMATION_PREFIX}:`;
  if (!customId.startsWith(prefix)) {
    return undefined;
  }
  const confirmationId = customId.slice(prefix.length);
  return confirmationId.length > 0 && !confirmationId.includes(':') ? confirmationId : undefined;
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
    case 'active_competition_locked':
      return {
        kind: 'active_competition_locked',
        message: 'This account contributes to an active competition and cannot be removed.',
      };
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

function notInGuildDefaultSelection(): AccountDefaultSelectionCommandResult {
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

function renameModal(customId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Rename an OSRS account')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(USERNAME_INPUT_ID)
          .setLabel('New OSRS username')
          .setRequired(true)
          .setStyle(TextInputStyle.Short),
      ),
    );
}

async function replyRegistrationResult(
  interaction: ModalSubmitInteraction,
  result: AccountRegistrationCommandResult,
): Promise<void> {
  await interaction.reply({ ...registrationResponse(result), flags: MessageFlags.Ephemeral });
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
      };
    case 'username_required':
      return {
        components: [],
        content: 'Run `/account register` again to enter an OSRS username.',
      };
    default:
      return { components: [], content: result.message };
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
        announcement: `**${result.account.displayUsername}** has been registered as ${indefiniteArticle(result.account.accountMode)} ${accountModeLabel(result.account.accountMode)} ${result.account.association.type} account.`,
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

function encodeRenameInteraction(accountId: string): string {
  return `${RENAME_INTERACTION_PREFIX}:${accountId}`;
}

function decodeRenameInteraction(customId: string): string | undefined {
  const prefix = `${RENAME_INTERACTION_PREFIX}:`;
  if (!customId.startsWith(prefix)) {
    return undefined;
  }
  const accountId = customId.slice(prefix.length);
  return accountId.length > 0 && !accountId.includes(':') ? accountId : undefined;
}

function encodeModeInteraction(accountId: string): string {
  return `${MODE_INTERACTION_PREFIX}:${accountId}`;
}

function decodeModeInteraction(customId: string): string | undefined {
  const prefix = `${MODE_INTERACTION_PREFIX}:`;
  if (!customId.startsWith(prefix)) return undefined;
  const accountId = customId.slice(prefix.length);
  return accountId.length > 0 && !accountId.includes(':') ? accountId : undefined;
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

function renameCommandResult(
  result: RenameAccountResult,
  recordAudit: (event: Parameters<AuditService['record']>[0]) => StructuredLogEntry,
  actor: { guildId: string; requesterDiscordUserId: string },
): AccountRenameCommandResult {
  switch (result.kind) {
    case 'renamed':
      return {
        auditEntry: recordAudit({
          context: {
            accountId: result.account.id,
            accountMode: result.account.accountMode,
            actorDiscordUserId: actor.requesterDiscordUserId,
            associationType: result.account.association.type,
            newDisplayUsername: result.account.displayUsername,
            previousDisplayUsername: result.previousDisplayUsername,
          },
          guildId: actor.guildId,
          occurredAt: new Date(),
          operation: 'account.rename',
          severity: 'info',
          type: 'account-edit-or-deletion',
        }),
        kind: 'renamed',
        message: `Renamed the tracked account to **${result.account.displayUsername}**.`,
      };
    case 'account_not_found':
      return { kind: 'account_not_found', message: 'That tracked account is no longer available.' };
    case 'forbidden':
      return { kind: 'forbidden', message: 'You are not allowed to rename that account.' };
    case 'active_competition_locked':
      return {
        kind: 'active_competition_locked',
        message:
          'This account contributes to an active competition and can only be renamed by an account administrator.',
      };
    case 'active_competition_confirmation_required':
      throw new Error(
        'Active competition rename confirmation must be handled before presentation.',
      );
    case 'invalid_username':
      return { kind: 'invalid_username', message: 'That OSRS username is invalid.' };
    case 'username_taken':
      return {
        kind: 'username_taken',
        message: 'That OSRS username is already tracked in this server.',
      };
    case 'hiscores_failure':
      return { kind: 'hiscores_failure', message: hiscoresFailureMessage(result.failure.kind) };
  }
}

function renderRenameAuditEntry(auditEntry: StructuredLogEntry): string {
  const context = auditEntry.context;
  const previousDisplayUsername = stringContextValue(context, 'previousDisplayUsername');
  const newDisplayUsername = stringContextValue(context, 'newDisplayUsername');
  const actorDiscordUserId = stringContextValue(context, 'actorDiscordUserId');
  if (
    previousDisplayUsername === undefined ||
    newDisplayUsername === undefined ||
    actorDiscordUserId === undefined
  ) {
    return 'A tracked OSRS account was renamed.';
  }
  return `Renamed tracked account **${previousDisplayUsername}** to **${newDisplayUsername}** by <@${actorDiscordUserId}>.`;
}

function modeCommandResult(
  result: ChangeAccountModeResult,
  recordAudit: (event: Parameters<AuditService['record']>[0]) => StructuredLogEntry,
  actor: { guildId: string; requesterDiscordUserId: string },
): AccountModeCommandResult {
  switch (result.kind) {
    case 'mode_changed':
      return {
        auditEntry: recordAudit({
          context: {
            accountId: result.account.id,
            accountMode: result.account.accountMode,
            actorDiscordUserId: actor.requesterDiscordUserId,
            associationType: result.account.association.type,
            displayUsername: result.account.displayUsername,
          },
          guildId: actor.guildId,
          occurredAt: new Date(),
          operation: 'account.mode_change',
          severity: 'info',
          type: 'account-edit-or-deletion',
        }),
        kind: 'mode_changed',
        message: `Changed **${result.account.displayUsername}** to ${accountModeLabel(result.account.accountMode)}.`,
      };
    case 'account_not_found':
      return { kind: 'account_not_found', message: 'That tracked account is no longer available.' };
    case 'active_competition_locked':
      return {
        kind: 'active_competition_locked',
        message:
          'This account contributes to an active competition and its game mode cannot be changed.',
      };
    case 'forbidden':
      return { kind: 'forbidden', message: 'You are not allowed to change that account mode.' };
    case 'hiscores_failure':
      return { kind: 'hiscores_failure', message: hiscoresFailureMessage(result.failure.kind) };
  }
}

function renderModeAuditEntry(auditEntry: StructuredLogEntry): string {
  const accountMode = stringContextValue(auditEntry.context, 'accountMode');
  const actorDiscordUserId = stringContextValue(auditEntry.context, 'actorDiscordUserId');
  const displayUsername = stringContextValue(auditEntry.context, 'displayUsername');
  if (
    accountMode === undefined ||
    actorDiscordUserId === undefined ||
    displayUsername === undefined
  ) {
    return 'A tracked OSRS account game mode was changed.';
  }
  return `Changed tracked account **${displayUsername}** to ${accountModeLabel(accountMode as OsrsAccountMode)} by <@${actorDiscordUserId}>.`;
}

function stringContextValue(
  context: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = context?.[key];
  return typeof value === 'string' ? value : undefined;
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
