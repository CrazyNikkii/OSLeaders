import {
  ActionRowBuilder,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { DiscordInteractionRegistrar } from './discord-interaction-dispatcher.js';
import {
  discordCommandCooldownMessage,
  InMemoryDiscordCommandCooldown,
} from './discord-command-cooldown.js';

import { SkillLookupService, type SkillLookupResult } from '../../features/lookups/skill-lookup.js';
import {
  OSRS_ACCOUNT_MODES,
  OSRS_SKILL_NAMES,
  type OsrsAccountMode,
  type OsrsSkillName,
} from '../hiscores/osrs-hiscore-catalog.js';
import { skillLookupEmbed, skillLookupFailureMessage } from './skill-lookup-command.js';

const COMMAND_NAME = 'one-time-skill';
const INTERACTION_PREFIX = 'osleaders:one-time-skill';
const USERNAME_INPUT_ID = 'username';
const SESSION_LIFETIME_MS = 5 * 60 * 1000;
const MAX_PENDING_SESSIONS = 1_000;

export const oneTimeSkillLookupCommandDefinitions = [
  new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription('Look up an OSRS skill for an unregistered account.')
    .setDMPermission(false)
    .toJSON(),
] as const;

export interface Clock {
  now(): Date;
}

export interface OneTimeSkillLookupSession {
  accountMode?: OsrsAccountMode;
  expiresAt: Date;
  guildId: string;
  requesterDiscordUserId: string;
  username?: string;
}

export interface OneTimeSkillLookupSessionStore {
  create(session: OneTimeSkillLookupSession): string;
  consume(
    sessionId: string,
    expected: Pick<OneTimeSkillLookupSession, 'guildId' | 'requesterDiscordUserId'>,
  ): OneTimeSkillLookupSession | 'expired' | 'mismatch' | undefined;
  update(
    sessionId: string,
    expected: Pick<OneTimeSkillLookupSession, 'guildId' | 'requesterDiscordUserId'>,
    update: Pick<OneTimeSkillLookupSession, 'accountMode' | 'username'>,
  ): OneTimeSkillLookupSession | 'expired' | 'mismatch' | undefined;
}

export class InMemoryOneTimeSkillLookupSessionStore implements OneTimeSkillLookupSessionStore {
  private readonly sessions = new Map<string, OneTimeSkillLookupSession>();

  public constructor(
    private readonly clock: Clock = { now: () => new Date() },
    private readonly maximumPendingSessions = MAX_PENDING_SESSIONS,
  ) {
    if (!Number.isSafeInteger(maximumPendingSessions) || maximumPendingSessions < 1) {
      throw new Error('maximumPendingSessions must be a positive safe integer.');
    }
  }

  public create(session: OneTimeSkillLookupSession): string {
    this.pruneExpired();
    while (this.sessions.size >= this.maximumPendingSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.sessions.delete(oldest);
    }
    const sessionId = randomUUID();
    this.sessions.set(sessionId, session);
    return sessionId;
  }

  public consume(
    sessionId: string,
    expected: Pick<OneTimeSkillLookupSession, 'guildId' | 'requesterDiscordUserId'>,
  ): OneTimeSkillLookupSession | 'expired' | 'mismatch' | undefined {
    const session = this.get(sessionId, expected);
    if (typeof session === 'object') {
      this.sessions.delete(sessionId);
    }
    return session;
  }

  public update(
    sessionId: string,
    expected: Pick<OneTimeSkillLookupSession, 'guildId' | 'requesterDiscordUserId'>,
    update: Pick<OneTimeSkillLookupSession, 'accountMode' | 'username'>,
  ): OneTimeSkillLookupSession | 'expired' | 'mismatch' | undefined {
    const session = this.get(sessionId, expected);
    if (typeof session !== 'object') {
      return session;
    }
    const updated = { ...session, ...update };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  private get(
    sessionId: string,
    expected: Pick<OneTimeSkillLookupSession, 'guildId' | 'requesterDiscordUserId'>,
  ): OneTimeSkillLookupSession | 'expired' | 'mismatch' | undefined {
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

  private pruneExpired(): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt.getTime() <= this.clock.now().getTime()) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

export type OneTimeSkillLookupCommandResult =
  | { kind: 'username_required'; customId: string }
  | { kind: 'mode_selection'; customId: string }
  | { kind: 'skill_selection'; customId: string }
  | { kind: 'found'; embed: EmbedBuilder }
  | { kind: 'failed'; message: string }
  | { kind: 'expired'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'not_in_guild'; message: string };

export class OneTimeSkillLookupCommandHandler {
  public constructor(
    private readonly skillLookup: Pick<SkillLookupService, 'lookup'>,
    private readonly sessions: OneTimeSkillLookupSessionStore = new InMemoryOneTimeSkillLookupSessionStore(),
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  public start(
    guildId: string | null,
    requesterDiscordUserId: string,
  ): Extract<OneTimeSkillLookupCommandResult, { kind: 'username_required' | 'not_in_guild' }> {
    if (guildId === null) {
      return notInGuild();
    }
    const sessionId = this.sessions.create({
      expiresAt: new Date(this.clock.now().getTime() + SESSION_LIFETIME_MS),
      guildId,
      requesterDiscordUserId,
    });
    return { kind: 'username_required', customId: encode('username', sessionId) };
  }

  public submitUsername(
    guildId: string | null,
    requesterDiscordUserId: string,
    customId: string,
    username: string,
  ): OneTimeSkillLookupCommandResult {
    const sessionId = decode(customId, 'username');
    const binding = bindingFor(guildId, requesterDiscordUserId);
    if (sessionId === undefined || binding === undefined) {
      return invalid(guildId);
    }
    const session = this.sessions.update(sessionId, binding, { username });
    if (typeof session !== 'object') {
      return sessionFailure(session);
    }
    return { kind: 'mode_selection', customId: encode('mode', sessionId) };
  }

  public selectMode(
    guildId: string | null,
    requesterDiscordUserId: string,
    customId: string,
    accountMode: string,
  ): OneTimeSkillLookupCommandResult {
    const sessionId = decode(customId, 'mode');
    const binding = bindingFor(guildId, requesterDiscordUserId);
    if (sessionId === undefined || binding === undefined || !isOsrsAccountMode(accountMode)) {
      return invalid(guildId);
    }
    const session = this.sessions.update(sessionId, binding, { accountMode });
    if (typeof session !== 'object') {
      return sessionFailure(session);
    }
    return { kind: 'skill_selection', customId: encode('skill', sessionId) };
  }

  public async selectSkill(
    guildId: string | null,
    requesterDiscordUserId: string,
    customId: string,
    skill: string,
  ): Promise<OneTimeSkillLookupCommandResult> {
    const sessionId = decode(customId, 'skill');
    const binding = bindingFor(guildId, requesterDiscordUserId);
    if (sessionId === undefined || binding === undefined || !isOsrsSkillName(skill)) {
      return invalid(guildId);
    }
    const session = this.sessions.consume(sessionId, binding);
    if (typeof session !== 'object') {
      return sessionFailure(session);
    }
    if (session.username === undefined || session.accountMode === undefined) {
      return {
        kind: 'forbidden',
        message: 'This one-time lookup flow is invalid. Run `/one-time-skill` again.',
      };
    }
    const result = await this.skillLookup.lookup({
      guildId: binding.guildId,
      requesterDiscordUserId,
      skill,
      target: {
        accountMode: session.accountMode,
        kind: 'one_time_account',
        username: session.username,
      },
    });
    return lookupResult(result);
  }
}

export class DiscordOneTimeSkillLookupCommandAdapter {
  public constructor(
    private readonly handler: OneTimeSkillLookupCommandHandler,
    private readonly cooldown: InMemoryDiscordCommandCooldown = new InMemoryDiscordCommandCooldown(),
  ) {}

  public async handle(
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== COMMAND_NAME) return;
      const result = this.handler.start(interaction.guildId, interaction.user.id);
      if (result.kind === 'username_required') {
        await interaction.showModal(usernameModal(result.customId));
      } else {
        await interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
      }
      return;
    }
    if ('isModalSubmit' in interaction && interaction.isModalSubmit()) {
      if (decode(interaction.customId, 'username') === undefined) return;
      const result = this.handler.submitUsername(
        interaction.guildId,
        interaction.user.id,
        interaction.customId,
        interaction.fields.getTextInputValue(USERNAME_INPUT_ID),
      );
      await interaction.reply({ ...response(result), flags: MessageFlags.Ephemeral });
      return;
    }
    if ('isStringSelectMenu' in interaction && interaction.isStringSelectMenu()) {
      const value = interaction.values[0] ?? '';
      if (decode(interaction.customId, 'mode') !== undefined) {
        await interaction.update(
          response(
            this.handler.selectMode(
              interaction.guildId,
              interaction.user.id,
              interaction.customId,
              value,
            ),
          ),
        );
      } else if (decode(interaction.customId, 'skill') !== undefined) {
        if (interaction.guildId !== null) {
          const cooldown = this.cooldown.tryAcquire({
            guildId: interaction.guildId,
            requesterDiscordUserId: interaction.user.id,
          });
          if (cooldown.kind === 'cooling_down') {
            await interaction.reply({
              content: discordCommandCooldownMessage(cooldown.retryAfterSeconds),
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
        }
        await interaction.deferUpdate();
        await interaction.editReply(
          response(
            await this.handler.selectSkill(
              interaction.guildId,
              interaction.user.id,
              interaction.customId,
              value,
            ),
          ),
        );
      }
    }
  }
}

export function bindDiscordOneTimeSkillLookupCommandAdapter(
  client: DiscordInteractionRegistrar,
  adapter: DiscordOneTimeSkillLookupCommandAdapter,
  reportUnexpectedError: (error: unknown) => void,
  shouldHandleInteraction: (interaction: Interaction) => boolean = () => true,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!shouldHandleInteraction(interaction)) return;
    if (
      interaction.isChatInputCommand() ||
      interaction.isModalSubmit() ||
      interaction.isStringSelectMenu()
    ) {
      void adapter.handle(interaction).catch(reportUnexpectedError);
    }
  });
}

function usernameModal(customId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('One-time OSRS skill lookup')
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

function response(result: OneTimeSkillLookupCommandResult) {
  switch (result.kind) {
    case 'mode_selection':
      return {
        content: 'Choose the account game mode.',
        components: [
          select(
            result.customId,
            'Choose game mode',
            OSRS_ACCOUNT_MODES.map((value) => ({ label: accountModeLabel(value), value })),
          ),
        ],
      };
    case 'skill_selection':
      return {
        content: 'Choose the skill to look up.',
        components: [
          select(
            result.customId,
            'Choose skill',
            OSRS_SKILL_NAMES.map((value) => ({ label: value, value })),
          ),
        ],
      };
    case 'found':
      return { components: [], embeds: [result.embed] };
    case 'username_required':
      return { components: [], content: 'Run `/one-time-skill` again to enter an OSRS username.' };
    default:
      return { components: [], content: result.message };
  }
}

function select(
  customId: string,
  placeholder: string,
  options: readonly { label: string; value: string }[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions([...options]),
  );
}

function lookupResult(result: SkillLookupResult): OneTimeSkillLookupCommandResult {
  return result.kind === 'found'
    ? { kind: 'found', embed: skillLookupEmbed(result) }
    : { kind: 'failed', message: skillLookupFailureMessage(result) };
}

function encode(kind: 'username' | 'mode' | 'skill', sessionId: string): string {
  return `${INTERACTION_PREFIX}:${kind}:${sessionId}`;
}
function decode(customId: string, kind: 'username' | 'mode' | 'skill'): string | undefined {
  const prefix = `${INTERACTION_PREFIX}:${kind}:`;
  const sessionId = customId.startsWith(prefix) ? customId.slice(prefix.length) : '';
  return sessionId.length > 0 && !sessionId.includes(':') ? sessionId : undefined;
}
function bindingFor(guildId: string | null, requesterDiscordUserId: string) {
  return guildId === null ? undefined : { guildId, requesterDiscordUserId };
}
function isOsrsAccountMode(value: string): value is OsrsAccountMode {
  return (OSRS_ACCOUNT_MODES as readonly string[]).includes(value);
}
function isOsrsSkillName(value: string): value is OsrsSkillName {
  return (OSRS_SKILL_NAMES as readonly string[]).includes(value);
}
function accountModeLabel(mode: OsrsAccountMode): string {
  return mode
    .split('_')
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(' ');
}
function notInGuild(): Extract<OneTimeSkillLookupCommandResult, { kind: 'not_in_guild' }> {
  return { kind: 'not_in_guild', message: 'This command can only be used in a Discord server.' };
}
function invalid(guildId: string | null): OneTimeSkillLookupCommandResult {
  return guildId === null
    ? notInGuild()
    : { kind: 'forbidden', message: 'You are not allowed to use this one-time lookup flow.' };
}
function sessionFailure(
  failure: 'expired' | 'mismatch' | undefined,
): OneTimeSkillLookupCommandResult {
  return failure === 'expired'
    ? {
        kind: 'expired',
        message: 'This one-time lookup flow has expired. Run `/one-time-skill` again.',
      }
    : { kind: 'forbidden', message: 'You are not allowed to use this one-time lookup flow.' };
}
