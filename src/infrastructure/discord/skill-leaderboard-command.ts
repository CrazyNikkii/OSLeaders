import {
  EmbedBuilder,
  Events,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from 'discord.js';

import {
  SkillLeaderboardService,
  type SkillLeaderboardEntry,
  type SkillLeaderboardFailure,
  type SkillLeaderboardResult,
} from '../../features/leaderboards/skill-leaderboard.js';
import {
  OSRS_SKILL_NAMES,
  type OsrsAccountMode,
  type OsrsSkillName,
} from '../hiscores/osrs-hiscore-catalog.js';

const SKILL_LEADERBOARD_COMMAND_NAME = 'skill-leaderboard';
const SKILL_OPTION_NAME = 'skill';
const RESULTS_OPTION_NAME = 'results';
const TOP_TEN_RESULTS_VALUE = 'top_10';
const ALL_RESULTS_VALUE = 'all';
const TOP_ENTRY_COUNT = 10;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_EMBED_DESCRIPTION_LENGTH = 4_096;

export const skillLeaderboardCommandDefinitions = [
  new SlashCommandBuilder()
    .setName(SKILL_LEADERBOARD_COMMAND_NAME)
    .setDescription('Compare tracked OSRS accounts by skill experience.')
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName(SKILL_OPTION_NAME)
        .setDescription('The skill to rank.')
        .setRequired(true)
        .addChoices(...OSRS_SKILL_NAMES.map((skill) => ({ name: skill, value: skill }))),
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

export interface SkillLeaderboardCommandServices {
  skillLeaderboard: Pick<SkillLeaderboardService, 'getLeaderboard'>;
}

export class SkillLeaderboardCommandHandler {
  public constructor(private readonly services: SkillLeaderboardCommandServices) {}

  public getLeaderboard(
    guildId: string | null,
    skill: OsrsSkillName,
  ): Promise<SkillLeaderboardResult | { kind: 'not_in_guild' }> {
    if (guildId === null) {
      return Promise.resolve({ kind: 'not_in_guild' });
    }

    return this.services.skillLeaderboard.getLeaderboard({ guildId, skill });
  }
}

export class DiscordSkillLeaderboardCommandAdapter {
  public constructor(private readonly handler: SkillLeaderboardCommandHandler) {}

  public async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName !== SKILL_LEADERBOARD_COMMAND_NAME) {
      return;
    }

    if (interaction.guildId === null) {
      await interaction.reply({ content: 'This command can only be used in a Discord server.' });
      return;
    }

    await interaction.deferReply();
    const result = await this.handler.getLeaderboard(
      interaction.guildId,
      interaction.options.getString(SKILL_OPTION_NAME, true) as OsrsSkillName,
    );
    if ('kind' in result) {
      await interaction.reply({ content: 'This command can only be used in a Discord server.' });
      return;
    }

    const limit =
      interaction.options.getString(RESULTS_OPTION_NAME) === ALL_RESULTS_VALUE
        ? undefined
        : TOP_ENTRY_COUNT;
    await replyWithEmbeds(interaction, skillLeaderboardEmbeds(result, limit));
  }
}

export function bindDiscordSkillLeaderboardCommandAdapter(
  client: Client,
  adapter: DiscordSkillLeaderboardCommandAdapter,
  reportUnexpectedError: (error: unknown) => void,
  shouldHandleInteraction: (interaction: Interaction) => boolean = () => true,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!shouldHandleInteraction(interaction) || !interaction.isChatInputCommand()) {
      return;
    }
    void adapter.handle(interaction).catch(reportUnexpectedError);
  });
}

export function skillLeaderboardEmbeds(
  result: SkillLeaderboardResult,
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
        `${result.skill} leaderboard${pages.length > 1 ? ` (${index + 1}/${pages.length})` : ''}`,
      )
      .setDescription(page),
  );
}

function entrySections(entries: readonly SkillLeaderboardEntry[]): RenderSection[] {
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

function failureSections(failures: readonly SkillLeaderboardFailure[]): RenderSection[] {
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

function formatEntry(rank: number, entry: SkillLeaderboardEntry): string {
  return `${rank}. ${accountLabel(entry.account)} — Level ${entry.skill.level} · ${entry.skill.experience.toLocaleString('en-US')} XP`;
}

function accountLabel(entry: SkillLeaderboardEntry['account']): string {
  const association =
    entry.association.type === 'watchlist' ? 'Watchlist' : `<@${entry.association.discordUserId}>`;
  return `**${entry.displayUsername}** (${accountModeLabel(entry.accountMode)} · ${association})`;
}

function failureMessage(failure: SkillLeaderboardFailure): string {
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
