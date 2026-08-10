import {
  EmbedBuilder,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'node:crypto';

import {
  BossLeaderboardService,
  type BossLeaderboardEntry,
  type BossLeaderboardFailure,
  type BossLeaderboardResult,
} from '../../features/leaderboards/boss-leaderboard.js';
import {
  OSRS_BOSS_ACTIVITY_NAMES,
  type OsrsBossActivityName,
} from '../hiscores/osrs-hiscore-catalog.js';
import { bossChoiceMenuRows } from './boss-choice-menu.js';
import { accountModeLabel, OSLEADERS_EMBED_COLOR } from './discord-embed-presentation.js';

const BOSS_LEADERBOARD_COMMAND_NAME = 'boss-leaderboard';
const RESULTS_OPTION_NAME = 'results';
const TOP_TEN_RESULTS_VALUE = 'top_10';
const ALL_RESULTS_VALUE = 'all';
const TOP_ENTRY_COUNT = 10;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_EMBED_DESCRIPTION_LENGTH = 4_096;
const INTERACTION_PREFIX = 'osleaders:boss-leaderboard';
const SESSION_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_PENDING_SESSIONS = 1_000;

export const bossLeaderboardCommandDefinitions = [
  new SlashCommandBuilder()
    .setName(BOSS_LEADERBOARD_COMMAND_NAME)
    .setDescription('Compare tracked OSRS accounts by boss kill count.')
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName(RESULTS_OPTION_NAME)
        .setDescription('How many accounts to show.')
        .addChoices(
          { name: 'Top 10', value: TOP_TEN_RESULTS_VALUE },
          { name: 'All', value: ALL_RESULTS_VALUE },
        ),
    )
    .toJSON(),
] as const;

export interface BossLeaderboardCommandServices {
  bossLeaderboard: Pick<BossLeaderboardService, 'getLeaderboard'>;
}

interface BossLeaderboardSelectionSession {
  expiresAt: Date;
  guildId: string;
  limit: number | undefined;
  requesterDiscordUserId: string;
}

export class BossLeaderboardCommandHandler {
  private readonly sessions = new Map<string, BossLeaderboardSelectionSession>();

  public constructor(
    private readonly services: BossLeaderboardCommandServices,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public start(
    guildId: string | null,
    requesterDiscordUserId: string,
    results: string | null,
  ):
    | { kind: 'boss_selection'; customIds: readonly string[] }
    | { kind: 'not_in_guild'; message: string } {
    if (guildId === null) {
      return {
        kind: 'not_in_guild',
        message: 'This command can only be used in a Discord server.',
      };
    }
    this.pruneExpired();
    while (this.sessions.size >= MAX_PENDING_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      expiresAt: new Date(this.now().getTime() + SESSION_LIFETIME_MS),
      guildId,
      limit: results === ALL_RESULTS_VALUE ? undefined : TOP_ENTRY_COUNT,
      requesterDiscordUserId,
    });
    return {
      kind: 'boss_selection',
      customIds: bossChoiceMenuRows((index) => encodeBossSelection(index, sessionId)).map(
        (row) => row.components[0]?.data.custom_id ?? '',
      ),
    };
  }

  public async selectBoss(
    guildId: string | null,
    requesterDiscordUserId: string,
    customId: string,
    boss: string,
  ): Promise<
    | { kind: 'leaderboard'; limit: number | undefined; result: BossLeaderboardResult }
    | { kind: 'expired' | 'forbidden' | 'invalid_boss'; message: string }
  > {
    const sessionId = decodeBossSelection(customId);
    if (sessionId === undefined || guildId === null || !isOsrsBossActivityName(boss)) {
      return { kind: 'invalid_boss', message: 'Choose a boss from the listed choices.' };
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.expiresAt.getTime() <= this.now().getTime()) {
      this.sessions.delete(sessionId);
      return {
        kind: 'expired',
        message: 'This boss selection expired. Run `/boss-leaderboard` again.',
      };
    }
    if (session.guildId !== guildId || session.requesterDiscordUserId !== requesterDiscordUserId) {
      return {
        kind: 'forbidden',
        message: 'This boss selection belongs to another member or server.',
      };
    }
    this.sessions.delete(sessionId);
    return {
      kind: 'leaderboard',
      limit: session.limit,
      result: await this.services.bossLeaderboard.getLeaderboard({ boss, guildId }),
    };
  }

  private pruneExpired(): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt.getTime() <= this.now().getTime()) this.sessions.delete(sessionId);
    }
  }
}

export class DiscordBossLeaderboardCommandAdapter {
  public constructor(private readonly handler: BossLeaderboardCommandHandler) {}

  public async handle(
    interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  ): Promise<void> {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== BOSS_LEADERBOARD_COMMAND_NAME) return;
      const result = this.handler.start(
        interaction.guildId,
        interaction.user.id,
        interaction.options.getString(RESULTS_OPTION_NAME),
      );
      if (result.kind === 'not_in_guild') {
        await interaction.reply({ content: result.message });
        return;
      }
      await interaction.reply({
        components: bossChoiceMenuRows((index) => result.customIds[index] ?? ''),
        content: 'Choose a boss to rank.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (
      !interaction.isStringSelectMenu() ||
      decodeBossSelection(interaction.customId) === undefined
    )
      return;
    await interaction.deferUpdate();
    const result = await this.handler.selectBoss(
      interaction.guildId,
      interaction.user.id,
      interaction.customId,
      interaction.values[0] ?? '',
    );
    if (result.kind !== 'leaderboard') {
      await interaction.editReply({ components: [], content: result.message });
      return;
    }
    try {
      await publishLeaderboardEmbeds(
        interaction,
        bossLeaderboardEmbeds(result.result, result.limit),
      );
    } catch (error) {
      await interaction.editReply({
        components: [],
        content: 'I could not publish that leaderboard publicly. Please try again.',
      });
      throw error;
    }
    await interaction.deleteReply();
  }
}

export function bindDiscordBossLeaderboardCommandAdapter(
  client: Client,
  adapter: DiscordBossLeaderboardCommandAdapter,
  reportUnexpectedError: (error: unknown) => void,
  shouldHandleInteraction: (interaction: Interaction) => boolean = () => true,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (
      !shouldHandleInteraction(interaction) ||
      !(interaction.isChatInputCommand() || interaction.isStringSelectMenu())
    ) {
      return;
    }
    void adapter.handle(interaction).catch(reportUnexpectedError);
  });
}

export function bossLeaderboardEmbeds(
  result: BossLeaderboardResult,
  limit: number | undefined,
): EmbedBuilder[] {
  const entries = limit === undefined ? result.entries : result.entries.slice(0, limit);
  const sections = [...entrySections(entries), ...failureSections(result.failures)];
  if (sections.length === 0) {
    sections.push({
      heading: 'Results',
      lines: ['No tracked accounts are available in this server.'],
    });
  }

  const pages = splitSections(sections);
  return pages.map((page, index) =>
    new EmbedBuilder()
      .setColor(OSLEADERS_EMBED_COLOR)
      .setFooter({ text: `${entries.length} ranked account${entries.length === 1 ? '' : 's'}` })
      .setTitle(
        `${result.boss} leaderboard${pages.length > 1 ? ` (${index + 1}/${pages.length})` : ''}`,
      )
      .setDescription(page),
  );
}

function entrySections(entries: readonly BossLeaderboardEntry[]): RenderSection[] {
  if (entries.length === 0) {
    return [];
  }
  return [
    {
      heading: 'Rankings',
      lines: entries.map((entry, index) => formatEntry(index + 1, entry)),
    },
  ];
}

function failureSections(failures: readonly BossLeaderboardFailure[]): RenderSection[] {
  if (failures.length === 0) {
    return [];
  }
  return [
    {
      heading: 'Unavailable accounts',
      lines: failures.map(
        (failure) => `${accountLabel(failure.account)} — ${failureMessage(failure)}`,
      ),
    },
  ];
}

function formatEntry(rank: number, entry: BossLeaderboardEntry): string {
  return `${rank}. ${accountLabel(entry.account)} — ${entry.boss.score.toLocaleString('en-US')} KC`;
}

function accountLabel(entry: BossLeaderboardEntry['account']): string {
  const association =
    entry.association.type === 'watchlist' ? 'Watchlist' : `<@${entry.association.discordUserId}>`;
  return `**${entry.displayUsername}** (${accountModeLabel(entry.accountMode)} · ${association})`;
}

function failureMessage(failure: BossLeaderboardFailure): string {
  switch (failure.failure.kind) {
    case 'not_found':
      return 'not found on Hiscores';
    case 'timeout':
      return 'Hiscores timed out';
    case 'temporary_upstream_failure':
      return 'Hiscores is temporarily unavailable';
    case 'mode_incompatible':
      return 'the selected mode is incompatible with Hiscores';
    case 'malformed_response':
      return 'Hiscores returned malformed data';
    case 'incomplete_response':
      return 'Hiscores returned incomplete data';
  }
}

function isOsrsBossActivityName(value: string): value is OsrsBossActivityName {
  return OSRS_BOSS_ACTIVITY_NAMES.includes(value as OsrsBossActivityName);
}

function encodeBossSelection(index: number, sessionId: string): string {
  return `${INTERACTION_PREFIX}:${index}:${sessionId}`;
}

function decodeBossSelection(customId: string): string | undefined {
  const match = new RegExp(`^${INTERACTION_PREFIX}:\\d+:([^:]+)$`).exec(customId);
  return match?.[1];
}

interface RenderSection {
  heading: string;
  lines: readonly string[];
}

function splitSections(sections: readonly RenderSection[]): string[] {
  const pages: string[] = [];
  let page = '';
  for (const section of sections) {
    for (const line of [`**${section.heading}**`, ...section.lines]) {
      const candidate = page === '' ? line : `${page}\n${line}`;
      if (candidate.length > MAX_EMBED_DESCRIPTION_LENGTH && page !== '') {
        pages.push(page);
        page = line;
      } else {
        page = candidate;
      }
    }
  }
  if (page !== '') {
    pages.push(page);
  }
  return pages;
}

async function publishLeaderboardEmbeds(
  interaction: StringSelectMenuInteraction,
  embeds: readonly EmbedBuilder[],
): Promise<void> {
  const channel = interaction.channel;
  if (!channel?.isSendable()) {
    throw new Error('The boss leaderboard channel is not available for public results.');
  }
  for (const embedBatch of chunk(embeds, MAX_EMBEDS_PER_MESSAGE)) {
    await channel.send({ embeds: embedBatch });
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
