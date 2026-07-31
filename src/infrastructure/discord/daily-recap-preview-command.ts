import {
  EmbedBuilder,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from 'discord.js';

import type { TrackedAccount } from '../../features/accounts/register-account.js';
import {
  type DailyRecapAccountPresentation,
  type DailyRecapFailurePresentation,
  type DailyRecapPreview,
} from '../../features/recaps/daily-recap-presentation.js';
import { PreviewDailyRecapService } from '../../features/recaps/preview-daily-recap.js';

const RECAP_COMMAND_NAME = 'recap';
const PREVIEW_SUBCOMMAND_NAME = 'preview';
const MAX_EMBED_DESCRIPTION_LENGTH = 4_096;
const MAX_EMBEDS_PER_MESSAGE = 10;

export const dailyRecapPreviewCommandDefinitions = [
  new SlashCommandBuilder()
    .setName(RECAP_COMMAND_NAME)
    .setDescription('View or send a daily recap.')
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName(PREVIEW_SUBCOMMAND_NAME)
        .setDescription('Privately preview the current daily recap without updating baselines.'),
    )
    .toJSON(),
] as const;

export class DiscordDailyRecapPreviewCommandAdapter {
  public constructor(private readonly previewService: Pick<PreviewDailyRecapService, 'preview'>) {}

  public async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    if (
      interaction.commandName !== RECAP_COMMAND_NAME ||
      interaction.options.getSubcommand() !== PREVIEW_SUBCOMMAND_NAME
    ) {
      return;
    }

    if (interaction.guildId === null) {
      await interaction.reply({ content: 'This command can only be used in a Discord server.' });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await this.previewService.preview({
      guildId: interaction.guildId,
      isGuildMember: true,
      requesterDiscordUserId: interaction.user.id,
    });
    if (result.kind === 'forbidden') {
      await interaction.editReply({ content: 'You do not have permission to preview this recap.' });
      return;
    }
    await replyWithPrivateEmbeds(interaction, dailyRecapPreviewEmbeds(result.preview));
  }
}

export function bindDiscordDailyRecapPreviewCommandAdapter(
  client: Client,
  adapter: DiscordDailyRecapPreviewCommandAdapter,
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

export function dailyRecapPreviewEmbeds(preview: DailyRecapPreview): EmbedBuilder[] {
  const sections = [
    ...linkedMemberSections(preview),
    ...watchlistSections(preview),
    ...noActivitySections(preview),
    ...failureSections(preview),
  ];
  const pages = splitSections(sections);

  return pages.map((page, index) =>
    new EmbedBuilder()
      .setTitle(`Daily recap preview${pages.length > 1 ? ` (${index + 1}/${pages.length})` : ''}`)
      .setDescription(page),
  );
}

function linkedMemberSections(preview: DailyRecapPreview): RenderSection[] {
  return preview.presentation.linkedMembers.map((member) => ({
    heading: `<@${member.discordUserId}>`,
    lines: member.accounts.flatMap(accountLines),
  }));
}

function watchlistSections(preview: DailyRecapPreview): RenderSection[] {
  if (preview.presentation.watchlistAccounts.length === 0) {
    return [];
  }
  return [
    {
      heading: 'Watchlist accounts',
      lines: preview.presentation.watchlistAccounts.flatMap(accountLines),
    },
  ];
}

function noActivitySections(preview: DailyRecapPreview): RenderSection[] {
  return preview.presentation.noActivity
    ? [{ heading: 'Activity', lines: ['No tracked XP or boss KC gains since the previous recap.'] }]
    : [];
}

function failureSections(preview: DailyRecapPreview): RenderSection[] {
  if (preview.presentation.failures.length === 0) {
    return [];
  }
  return [
    {
      heading: 'Unavailable accounts',
      lines: preview.presentation.failures.map(formatFailure),
    },
  ];
}

function accountLines(entry: DailyRecapAccountPresentation): string[] {
  const lines = [`## ${entry.account.displayUsername} (${accountModeLabel(entry.account)})`];
  if (entry.changes.bosses.length > 0) {
    lines.push(
      '**Boss activities**',
      ...entry.changes.bosses.map(
        (change) => `• ${change.boss}: +${change.killCountGained.toLocaleString('en-US')} KC`,
      ),
    );
  }
  if (entry.changes.skills.length > 0) {
    lines.push('**Skills**', ...entry.changes.skills.map(formatSkillChange));
  }
  return lines;
}

function formatSkillChange(
  change: DailyRecapAccountPresentation['changes']['skills'][number],
): string {
  const gains: string[] = [];
  if (change.experienceGained > 0) {
    gains.push(`+${change.experienceGained.toLocaleString('en-US')} XP`);
  }
  if (change.levelGained > 0) {
    gains.push(
      `+${change.levelGained} ${change.levelGained === 1 ? 'level' : 'levels'} → ${change.currentLevel}`,
    );
  }
  return `• ${change.skill}: ${gains.join(', ')}`;
}

function formatFailure(entry: DailyRecapFailurePresentation): string {
  return `**${entry.account.displayUsername}** (${accountModeLabel(entry.account)}) — ${failureMessage(entry)}`;
}

function failureMessage(entry: DailyRecapFailurePresentation): string {
  switch (entry.failure.kind) {
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
    case 'baseline_incomplete':
      return 'its stored recap baseline is incomplete';
  }
}

function accountModeLabel(account: TrackedAccount): string {
  return account.accountMode
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
    for (const line of [`**${section.heading}**`, ...section.lines.flatMap(splitLongLine)]) {
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

function splitLongLine(line: string): string[] {
  const lines: string[] = [];
  for (let index = 0; index < line.length; index += MAX_EMBED_DESCRIPTION_LENGTH) {
    lines.push(line.slice(index, index + MAX_EMBED_DESCRIPTION_LENGTH));
  }
  return lines;
}

async function replyWithPrivateEmbeds(
  interaction: ChatInputCommandInteraction,
  embeds: readonly EmbedBuilder[],
): Promise<void> {
  const [firstMessage, ...additionalMessages] = chunk(embeds, MAX_EMBEDS_PER_MESSAGE);
  await interaction.editReply({ embeds: firstMessage ?? [] });
  for (const message of additionalMessages) {
    await interaction.followUp({ embeds: message, flags: MessageFlags.Ephemeral });
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
