import { randomUUID } from 'node:crypto';

import {
  EmbedBuilder,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';

import { AccountRetrievalService } from '../../features/accounts/account-retrieval.js';
import { BossLookupService, type BossLookupResult } from '../../features/lookups/boss-lookup.js';
import {
  type OsrsAccountMode,
  type OsrsBossActivityName,
} from '../hiscores/osrs-hiscore-catalog.js';
import { bossChoiceGroups, bossChoiceMenuRows } from './boss-choice-menu.js';

const BOSS_COMMAND_NAME = 'boss';
const ACCOUNT_OPTION_NAME = 'account';
const MAX_AUTOCOMPLETE_CHOICES = 25;
const MAX_PENDING_SESSIONS = 1_000;
const SESSION_LIFETIME_MS = 5 * 60 * 1_000;
const INTERACTION_PREFIX = 'osleaders:boss';

export const bossLookupCommandDefinitions = [
  new SlashCommandBuilder()
    .setName(BOSS_COMMAND_NAME)
    .setDescription('Look up an OSRS boss kill count for a tracked account.')
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName(ACCOUNT_OPTION_NAME)
        .setDescription('A tracked account; defaults to your default account.')
        .setAutocomplete(true),
    )
    .toJSON(),
] as const;

interface BossLookupSelectionSession {
  accountId: string | null;
  expiresAt: Date;
  guildId: string;
  requesterDiscordUserId: string;
}

export interface BossLookupClock {
  now(): Date;
}

export interface BossLookupCommandServices {
  accountRetrieval: Pick<AccountRetrievalService, 'listForGuild'>;
  bossLookup: Pick<BossLookupService, 'lookup'>;
}

export class BossLookupCommandHandler {
  private readonly sessions = new Map<string, BossLookupSelectionSession>();

  public constructor(
    private readonly services: BossLookupCommandServices,
    private readonly clock: BossLookupClock = { now: () => new Date() },
  ) {}

  public async autocomplete(
    guildId: string | null,
    optionName: string,
    query: string,
  ): Promise<{ name: string; value: string }[]> {
    if (optionName !== ACCOUNT_OPTION_NAME || guildId === null) return [];

    const normalizedQuery = query.trim().toLocaleLowerCase('en-US');
    const accounts = await this.services.accountRetrieval.listForGuild(guildId);
    return accounts
      .filter((account) =>
        account.displayUsername.toLocaleLowerCase('en-US').includes(normalizedQuery),
      )
      .slice(0, MAX_AUTOCOMPLETE_CHOICES)
      .map((account) => ({
        name: `${account.displayUsername} (${account.accountMode})`,
        value: account.id,
      }));
  }

  public start(
    guildId: string | null,
    requesterDiscordUserId: string,
    accountId: string | null,
  ): { kind: 'boss_selection'; customIds: readonly string[] } | { kind: 'not_in_guild' } {
    if (guildId === null) return { kind: 'not_in_guild' };
    this.pruneExpired();
    while (this.sessions.size >= MAX_PENDING_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      accountId,
      expiresAt: new Date(this.clock.now().getTime() + SESSION_LIFETIME_MS),
      guildId,
      requesterDiscordUserId,
    });
    return {
      kind: 'boss_selection',
      customIds: bossChoiceMenuRows((index) => encodeBossSelection(index, sessionId)).map(
        (row) => row.components[0]?.data.custom_id ?? '',
      ),
    };
  }

  public lookup(
    guildId: string | null,
    requesterDiscordUserId: string,
    boss: OsrsBossActivityName,
    accountId: string | null,
  ): Promise<BossLookupResult | { kind: 'not_in_guild' }> {
    if (guildId === null) return Promise.resolve({ kind: 'not_in_guild' });
    return this.services.bossLookup.lookup({
      boss,
      guildId,
      requesterDiscordUserId,
      target:
        accountId === null ? { kind: 'default_account' } : { accountId, kind: 'tracked_account' },
    });
  }

  public selectBoss(
    guildId: string | null,
    requesterDiscordUserId: string,
    customId: string,
    boss: string,
  ): Promise<
    BossLookupResult | { kind: 'expired' | 'invalid_boss' | 'not_in_guild' | 'forbidden' }
  > {
    const sessionId = decodeBossSelection(customId);
    if (guildId === null) return Promise.resolve({ kind: 'not_in_guild' });
    if (sessionId === undefined) return Promise.resolve({ kind: 'forbidden' });
    const session = this.sessions.get(sessionId);
    if (session !== undefined && session.expiresAt.getTime() <= this.clock.now().getTime()) {
      this.sessions.delete(sessionId);
      return Promise.resolve({ kind: 'expired' });
    }
    if (session?.guildId !== guildId || session.requesterDiscordUserId !== requesterDiscordUserId) {
      return Promise.resolve({ kind: 'forbidden' });
    }
    this.sessions.delete(sessionId);
    if (!isOsrsBossActivityName(boss)) return Promise.resolve({ kind: 'invalid_boss' });
    return this.lookup(guildId, requesterDiscordUserId, boss, session.accountId);
  }

  private pruneExpired(): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt.getTime() <= this.clock.now().getTime())
        this.sessions.delete(sessionId);
    }
  }
}

export class DiscordBossLookupCommandAdapter {
  public constructor(private readonly handler: BossLookupCommandHandler) {}

  public async handle(
    interaction:
      AutocompleteInteraction | ChatInputCommandInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName !== BOSS_COMMAND_NAME) return;
      const focused = interaction.options.getFocused(true);
      await interaction.respond(
        await this.handler.autocomplete(interaction.guildId, focused.name, focused.value),
      );
      return;
    }
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== BOSS_COMMAND_NAME) return;
      const result = this.handler.start(
        interaction.guildId,
        interaction.user.id,
        interaction.options.getString(ACCOUNT_OPTION_NAME),
      );
      if (result.kind === 'not_in_guild') {
        await interaction.reply({ content: 'This command can only be used in a Discord server.' });
        return;
      }
      await interaction.reply({
        components: bossChoiceMenuRows((index) => result.customIds[index] ?? ''),
        content: 'Choose the boss to look up.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (
      !interaction.isStringSelectMenu() ||
      decodeBossSelection(interaction.customId) === undefined
    ) {
      return;
    }
    await interaction.deferUpdate();
    const result = await this.handler.selectBoss(
      interaction.guildId,
      interaction.user.id,
      interaction.customId,
      interaction.values[0] ?? '',
    );
    if (result.kind === 'found') {
      try {
        await publishBossLookupResult(interaction, bossLookupEmbed(result));
      } catch (error) {
        await interaction.editReply({
          components: [],
          content: 'I could not publish that result publicly. Please try again.',
        });
        throw error;
      }
      await interaction.deleteReply();
      return;
    }
    await interaction.editReply({ components: [], content: bossLookupFailureMessage(result) });
  }
}

async function publishBossLookupResult(
  interaction: StringSelectMenuInteraction,
  embed: EmbedBuilder,
): Promise<void> {
  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    throw new Error('The boss lookup channel is not available for public results.');
  }
  await channel.send({ embeds: [embed] });
}

export function bindDiscordBossLookupCommandAdapter(
  client: Client,
  adapter: DiscordBossLookupCommandAdapter,
  reportUnexpectedError: (error: unknown) => void,
  shouldHandleInteraction: (interaction: Interaction) => boolean = () => true,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!shouldHandleInteraction(interaction)) return;
    if (
      interaction.isAutocomplete() ||
      interaction.isChatInputCommand() ||
      interaction.isStringSelectMenu()
    ) {
      void adapter.handle(interaction).catch(reportUnexpectedError);
    }
  });
}

export function createBossLookupCommandHandler(
  accountRetrieval: ConstructorParameters<typeof AccountRetrievalService>[0],
  bossLookup: Pick<BossLookupService, 'lookup'>,
): BossLookupCommandHandler {
  return new BossLookupCommandHandler({
    accountRetrieval: new AccountRetrievalService(accountRetrieval),
    bossLookup,
  });
}

export function bossLookupEmbed(
  result: Extract<BossLookupResult, { kind: 'found' }>,
): EmbedBuilder {
  const target = result.target.kind === 'tracked_account' ? result.target.account : result.target;
  return new EmbedBuilder()
    .setTitle(`${result.boss.name}: ${target.displayUsername}`)
    .addFields(
      { inline: true, name: 'Kill count', value: result.boss.score.toLocaleString('en-US') },
      { inline: true, name: 'Rank', value: formatRank(result.boss.rank) },
      { inline: true, name: 'Mode', value: accountModeLabel(target.accountMode) },
    );
}

export function bossLookupFailureMessage(
  result:
    | Exclude<BossLookupResult, { kind: 'found' }>
    | { kind: 'expired' | 'invalid_boss' | 'not_in_guild' | 'forbidden' },
): string {
  switch (result.kind) {
    case 'not_in_guild':
      return 'This command can only be used in a Discord server.';
    case 'invalid_boss':
      return 'Choose a boss from the listed choices.';
    case 'forbidden':
      return 'You are not allowed to use that boss selection.';
    case 'expired':
      return 'This boss selection has expired. Run `/boss` again.';
    case 'default_account_not_found':
      return 'You do not have a default linked account in this server.';
    case 'account_not_found':
      return 'That tracked account is no longer available in this server.';
    case 'hiscores_failure':
      return 'Hiscores could not provide a complete result for that account right now.';
  }
}

function isOsrsBossActivityName(value: string): value is OsrsBossActivityName {
  return bossChoiceGroups.some((group) => group.some((choice) => choice.value === value));
}

function encodeBossSelection(index: number, sessionId: string): string {
  return `${INTERACTION_PREFIX}:${index}:${sessionId}`;
}

function decodeBossSelection(customId: string): string | undefined {
  const prefix = `${INTERACTION_PREFIX}:`;
  if (!customId.startsWith(prefix)) return undefined;
  const [index, sessionId, ...rest] = customId.slice(prefix.length).split(':');
  return Number.isSafeInteger(Number(index)) && Number(index) >= 0 && rest.length === 0 && sessionId
    ? sessionId
    : undefined;
}

function formatRank(rank: number): string {
  return rank === -1 ? 'Unranked' : rank.toLocaleString('en-US');
}

function accountModeLabel(mode: OsrsAccountMode): string {
  return mode
    .split('_')
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(' ');
}
