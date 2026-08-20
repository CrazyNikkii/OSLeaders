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

import { BossLookupService, type BossLookupResult } from '../../features/lookups/boss-lookup.js';
import {
  OSRS_ACCOUNT_MODES,
  OSRS_BOSS_ACTIVITY_NAMES,
  type OsrsAccountMode,
  type OsrsBossActivityName,
} from '../hiscores/osrs-hiscore-catalog.js';
import { bossLookupEmbed, bossLookupFailureMessage } from './boss-lookup-command.js';
import { bossChoiceMenuRows } from './boss-choice-menu.js';

const COMMAND_NAME = 'one-time-boss';
const INTERACTION_PREFIX = 'osleaders:one-time-boss';
const USERNAME_INPUT_ID = 'username';
const SESSION_LIFETIME_MS = 5 * 60 * 1000;
const MAX_PENDING_SESSIONS = 1_000;

export const oneTimeBossLookupCommandDefinitions = [
  new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription('Look up an OSRS boss kill count for an unregistered account.')
    .setDMPermission(false)
    .toJSON(),
] as const;

export interface OneTimeBossLookupClock {
  now(): Date;
}

export interface OneTimeBossLookupSession {
  accountMode?: OsrsAccountMode;
  expiresAt: Date;
  guildId: string;
  requesterDiscordUserId: string;
  username?: string;
}

export interface OneTimeBossLookupSessionStore {
  create(session: OneTimeBossLookupSession): string;
  consume(
    sessionId: string,
    expected: Pick<OneTimeBossLookupSession, 'guildId' | 'requesterDiscordUserId'>,
  ): OneTimeBossLookupSession | 'expired' | 'mismatch' | undefined;
  update(
    sessionId: string,
    expected: Pick<OneTimeBossLookupSession, 'guildId' | 'requesterDiscordUserId'>,
    update: Pick<OneTimeBossLookupSession, 'accountMode' | 'username'>,
  ): OneTimeBossLookupSession | 'expired' | 'mismatch' | undefined;
}

export class InMemoryOneTimeBossLookupSessionStore implements OneTimeBossLookupSessionStore {
  private readonly sessions = new Map<string, OneTimeBossLookupSession>();

  public constructor(
    private readonly clock: OneTimeBossLookupClock = { now: () => new Date() },
    private readonly maximumPendingSessions = MAX_PENDING_SESSIONS,
  ) {
    if (!Number.isSafeInteger(maximumPendingSessions) || maximumPendingSessions < 1) {
      throw new Error('maximumPendingSessions must be a positive safe integer.');
    }
  }

  public create(session: OneTimeBossLookupSession): string {
    this.pruneExpired();
    while (this.sessions.size >= this.maximumPendingSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const sessionId = randomUUID();
    this.sessions.set(sessionId, session);
    return sessionId;
  }

  public consume(
    sessionId: string,
    expected: Pick<OneTimeBossLookupSession, 'guildId' | 'requesterDiscordUserId'>,
  ): OneTimeBossLookupSession | 'expired' | 'mismatch' | undefined {
    const session = this.get(sessionId, expected);
    if (typeof session === 'object') this.sessions.delete(sessionId);
    return session;
  }

  public update(
    sessionId: string,
    expected: Pick<OneTimeBossLookupSession, 'guildId' | 'requesterDiscordUserId'>,
    update: Pick<OneTimeBossLookupSession, 'accountMode' | 'username'>,
  ): OneTimeBossLookupSession | 'expired' | 'mismatch' | undefined {
    const session = this.get(sessionId, expected);
    if (typeof session !== 'object') return session;
    const updated = { ...session, ...update };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  private get(
    sessionId: string,
    expected: Pick<OneTimeBossLookupSession, 'guildId' | 'requesterDiscordUserId'>,
  ): OneTimeBossLookupSession | 'expired' | 'mismatch' | undefined {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return undefined;
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
      if (session.expiresAt.getTime() <= this.clock.now().getTime())
        this.sessions.delete(sessionId);
    }
  }
}

export type OneTimeBossLookupCommandResult =
  | { kind: 'username_required'; customId: string }
  | { kind: 'mode_selection'; customId: string }
  | { kind: 'boss_selection'; customIds: readonly string[] }
  | { kind: 'invalid_boss'; message: string }
  | { kind: 'found'; embed: EmbedBuilder }
  | { kind: 'failed'; message: string }
  | { kind: 'expired'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'not_in_guild'; message: string };

export class OneTimeBossLookupCommandHandler {
  public constructor(
    private readonly bossLookup: Pick<BossLookupService, 'lookup'>,
    private readonly sessions: OneTimeBossLookupSessionStore = new InMemoryOneTimeBossLookupSessionStore(),
    private readonly clock: OneTimeBossLookupClock = { now: () => new Date() },
  ) {}

  public start(
    guildId: string | null,
    requesterDiscordUserId: string,
  ): Extract<OneTimeBossLookupCommandResult, { kind: 'username_required' | 'not_in_guild' }> {
    if (guildId === null) return notInGuild();
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
  ): OneTimeBossLookupCommandResult {
    const sessionId = decode(customId, 'username');
    const binding = bindingFor(guildId, requesterDiscordUserId);
    if (sessionId === undefined || binding === undefined) return invalid(guildId);
    const session = this.sessions.update(sessionId, binding, { username });
    if (typeof session !== 'object') return sessionFailure(session);
    return { kind: 'mode_selection', customId: encode('mode', sessionId) };
  }

  public selectMode(
    guildId: string | null,
    requesterDiscordUserId: string,
    customId: string,
    accountMode: string,
  ): OneTimeBossLookupCommandResult {
    const sessionId = decode(customId, 'mode');
    const binding = bindingFor(guildId, requesterDiscordUserId);
    if (sessionId === undefined || binding === undefined || !isOsrsAccountMode(accountMode)) {
      return invalid(guildId);
    }
    const session = this.sessions.update(sessionId, binding, { accountMode });
    if (typeof session !== 'object') return sessionFailure(session);
    return {
      kind: 'boss_selection',
      customIds: bossChoiceMenuRows((index) => encodeBoss(index, sessionId)).map(
        (row) => row.components[0]?.data.custom_id ?? '',
      ),
    };
  }

  public async selectBoss(
    guildId: string | null,
    requesterDiscordUserId: string,
    customId: string,
    boss: string,
  ): Promise<OneTimeBossLookupCommandResult> {
    const sessionId = decodeBoss(customId);
    const binding = bindingFor(guildId, requesterDiscordUserId);
    if (sessionId === undefined || binding === undefined) {
      return invalid(guildId);
    }
    if (!isOsrsBossActivityName(boss)) return invalidBoss();
    const session = this.sessions.consume(sessionId, binding);
    if (typeof session !== 'object') return sessionFailure(session);
    if (session.username === undefined || session.accountMode === undefined) {
      return {
        kind: 'forbidden',
        message: 'This one-time lookup flow is invalid. Run `/one-time-boss` again.',
      };
    }
    return lookupResult(
      await this.bossLookup.lookup({
        boss,
        guildId: binding.guildId,
        requesterDiscordUserId,
        target: {
          accountMode: session.accountMode,
          kind: 'one_time_account',
          username: session.username,
        },
      }),
    );
  }
}

export class DiscordOneTimeBossLookupCommandAdapter {
  public constructor(
    private readonly handler: OneTimeBossLookupCommandHandler,
    private readonly cooldown: InMemoryDiscordCommandCooldown = new InMemoryDiscordCommandCooldown(),
  ) {}

  public async handle(
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== COMMAND_NAME) return;
      const result = this.handler.start(interaction.guildId, interaction.user.id);
      if (result.kind === 'username_required')
        await interaction.showModal(usernameModal(result.customId));
      else await interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
      return;
    }
    if ('isModalSubmit' in interaction && interaction.isModalSubmit()) {
      if (decode(interaction.customId, 'username') !== undefined) {
        const result = this.handler.submitUsername(
          interaction.guildId,
          interaction.user.id,
          interaction.customId,
          interaction.fields.getTextInputValue(USERNAME_INPUT_ID),
        );
        await interaction.reply({ ...response(result), flags: MessageFlags.Ephemeral });
      }
      return;
    }
    if ('isStringSelectMenu' in interaction && interaction.isStringSelectMenu()) {
      const value = interaction.values[0] ?? '';
      if (decode(interaction.customId, 'mode') !== undefined) {
        const result = this.handler.selectMode(
          interaction.guildId,
          interaction.user.id,
          interaction.customId,
          value,
        );
        await interaction.update(response(result));
      } else if (decodeBoss(interaction.customId) !== undefined) {
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
        const result = await this.handler.selectBoss(
          interaction.guildId,
          interaction.user.id,
          interaction.customId,
          value,
        );
        if (result.kind === 'found') {
          try {
            await publishOneTimeBossLookupResult(interaction, result.embed);
          } catch (error) {
            await interaction.editReply({
              components: [],
              content: 'I could not publish that result publicly. Please try again.',
            });
            throw error;
          }
          await interaction.deleteReply();
        } else {
          await interaction.editReply(response(result));
        }
      }
    }
  }
}

async function publishOneTimeBossLookupResult(
  interaction: StringSelectMenuInteraction,
  embed: EmbedBuilder,
): Promise<void> {
  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    throw new Error('The one-time boss lookup channel is not available for public results.');
  }
  await channel.send({ embeds: [embed] });
}

export function bindDiscordOneTimeBossLookupCommandAdapter(
  client: DiscordInteractionRegistrar,
  adapter: DiscordOneTimeBossLookupCommandAdapter,
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
    .setTitle('One-time OSRS boss lookup')
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

function response(result: OneTimeBossLookupCommandResult) {
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
    case 'boss_selection':
      return {
        content: 'Choose the boss to look up.',
        components: bossChoiceMenuRows((index) => result.customIds[index] ?? ''),
      };
    case 'found':
      return { components: [], embeds: [result.embed] };
    case 'username_required':
      return { components: [], content: 'Run `/one-time-boss` again to enter an OSRS username.' };
    default:
      return { components: [], content: result.message };
  }
}

function select(
  customId: string,
  placeholder: string,
  options: readonly { label: string; value: string }[],
) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions([...options]),
  );
}

function lookupResult(result: BossLookupResult): OneTimeBossLookupCommandResult {
  return result.kind === 'found'
    ? { kind: 'found', embed: bossLookupEmbed(result) }
    : { kind: 'failed', message: bossLookupFailureMessage(result) };
}
function encode(kind: 'username' | 'mode' | 'boss', sessionId: string): string {
  return `${INTERACTION_PREFIX}:${kind}:${sessionId}`;
}
function encodeBoss(index: number, sessionId: string): string {
  return `${INTERACTION_PREFIX}:boss:${index}:${sessionId}`;
}
function decode(customId: string, kind: 'username' | 'mode' | 'boss'): string | undefined {
  const prefix = `${INTERACTION_PREFIX}:${kind}:`;
  const sessionId = customId.startsWith(prefix) ? customId.slice(prefix.length) : '';
  return sessionId.length > 0 && !sessionId.includes(':') ? sessionId : undefined;
}
function decodeBoss(customId: string): string | undefined {
  const prefix = `${INTERACTION_PREFIX}:boss:`;
  if (!customId.startsWith(prefix)) return undefined;
  const [index, sessionId, ...rest] = customId.slice(prefix.length).split(':');
  return Number.isSafeInteger(Number(index)) && Number(index) >= 0 && rest.length === 0 && sessionId
    ? sessionId
    : undefined;
}
function bindingFor(guildId: string | null, requesterDiscordUserId: string) {
  return guildId === null ? undefined : { guildId, requesterDiscordUserId };
}
function isOsrsAccountMode(value: string): value is OsrsAccountMode {
  return (OSRS_ACCOUNT_MODES as readonly string[]).includes(value);
}
function isOsrsBossActivityName(value: string): value is OsrsBossActivityName {
  return OSRS_BOSS_ACTIVITY_NAMES.includes(value as OsrsBossActivityName);
}
function accountModeLabel(mode: OsrsAccountMode): string {
  return mode
    .split('_')
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(' ');
}
function notInGuild(): Extract<OneTimeBossLookupCommandResult, { kind: 'not_in_guild' }> {
  return { kind: 'not_in_guild', message: 'This command can only be used in a Discord server.' };
}
function invalid(guildId: string | null): OneTimeBossLookupCommandResult {
  return guildId === null
    ? notInGuild()
    : { kind: 'forbidden', message: 'You are not allowed to use this one-time lookup flow.' };
}
function invalidBoss(): Extract<OneTimeBossLookupCommandResult, { kind: 'invalid_boss' }> {
  return {
    kind: 'invalid_boss',
    message:
      'That boss activity name is not supported. Run `/one-time-boss` again and enter a listed OSRS boss activity name.',
  };
}
function sessionFailure(
  failure: 'expired' | 'mismatch' | undefined,
): OneTimeBossLookupCommandResult {
  return failure === 'expired'
    ? {
        kind: 'expired',
        message: 'This one-time lookup flow has expired. Run `/one-time-boss` again.',
      }
    : { kind: 'forbidden', message: 'You are not allowed to use this one-time lookup flow.' };
}
