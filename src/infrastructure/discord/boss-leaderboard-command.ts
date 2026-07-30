import {
  EmbedBuilder,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from 'discord.js';

import {
  BossLeaderboardService,
  type BossLeaderboardEntry,
  type BossLeaderboardFailure,
  type BossLeaderboardResult,
} from '../../features/leaderboards/boss-leaderboard.js';
import {
  OSRS_BOSS_ACTIVITY_NAMES,
  type OsrsAccountMode,
  type OsrsBossActivityName,
} from '../hiscores/osrs-hiscore-catalog.js';

const BOSS_LEADERBOARD_COMMAND_NAME = 'boss-leaderboard';
const BOSS_OPTION_NAME = 'boss';
const RESULTS_OPTION_NAME = 'results';
const TOP_TEN_RESULTS_VALUE = 'top_10';
const ALL_RESULTS_VALUE = 'all';
const TOP_ENTRY_COUNT = 10;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_EMBED_DESCRIPTION_LENGTH = 4_096;
const MAX_AUTOCOMPLETE_CHOICES = 25;

export const bossLeaderboardCommandDefinitions = [
  new SlashCommandBuilder()
    .setName(BOSS_LEADERBOARD_COMMAND_NAME)
    .setDescription('Compare tracked OSRS accounts by boss kill count.')
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName(BOSS_OPTION_NAME)
        .setDescription('The boss to rank.')
        .setRequired(true)
        .setAutocomplete(true),
    )
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

export class BossLeaderboardCommandHandler {
  public constructor(private readonly services: BossLeaderboardCommandServices) {}

  public autocomplete(query: string): { name: string; value: string }[] {
    const normalizedQuery = query.trim().toLocaleLowerCase('en-US');
    return OSRS_BOSS_ACTIVITY_NAMES.filter((boss) =>
      boss.toLocaleLowerCase('en-US').includes(normalizedQuery),
    )
      .slice(0, MAX_AUTOCOMPLETE_CHOICES)
      .map((boss) => ({ name: boss, value: boss }));
  }

  public getLeaderboard(
    guildId: string,
    boss: OsrsBossActivityName,
  ): Promise<BossLeaderboardResult> {
    return this.services.bossLeaderboard.getLeaderboard({ boss, guildId });
  }
}

export class DiscordBossLeaderboardCommandAdapter {
  public constructor(private readonly handler: BossLeaderboardCommandHandler) {}

  public async handle(
    interaction: AutocompleteInteraction | ChatInputCommandInteraction,
  ): Promise<void> {
    if (interaction.commandName !== BOSS_LEADERBOARD_COMMAND_NAME) {
      return;
    }

    if (interaction.isAutocomplete()) {
      if (interaction.options.getFocused(true).name !== BOSS_OPTION_NAME) {
        return;
      }
      await interaction.respond(this.handler.autocomplete(interaction.options.getFocused()));
      return;
    }

    if (interaction.guildId === null) {
      await interaction.reply({ content: 'This command can only be used in a Discord server.' });
      return;
    }

    const boss = interaction.options.getString(BOSS_OPTION_NAME, true);
    if (!isOsrsBossActivityName(boss)) {
      await interaction.reply({
        content: 'Choose a boss from the autocomplete suggestions.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply();
    const result = await this.handler.getLeaderboard(interaction.guildId, boss);

    const limit =
      interaction.options.getString(RESULTS_OPTION_NAME) === ALL_RESULTS_VALUE
        ? undefined
        : TOP_ENTRY_COUNT;
    await replyWithEmbeds(interaction, bossLeaderboardEmbeds(result, limit));
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
      !(interaction.isAutocomplete() || interaction.isChatInputCommand())
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

function accountModeLabel(mode: OsrsAccountMode): string {
  return mode
    .split('_')
    .map((word) => `${word[0]?.toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function isOsrsBossActivityName(value: string): value is OsrsBossActivityName {
  return OSRS_BOSS_ACTIVITY_NAMES.includes(value as OsrsBossActivityName);
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

async function replyWithEmbeds(
  interaction: ChatInputCommandInteraction,
  embeds: readonly EmbedBuilder[],
): Promise<void> {
  const [firstMessage, ...additionalMessages] = chunk(embeds, MAX_EMBEDS_PER_MESSAGE);
  await interaction.editReply({ embeds: firstMessage ?? [] });
  for (const message of additionalMessages) {
    await interaction.followUp({ embeds: message });
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
