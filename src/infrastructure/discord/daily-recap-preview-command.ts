import {
  ChannelType,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import type { EmbedBuilder } from 'discord.js';
import type { DiscordInteractionRegistrar } from './discord-interaction-dispatcher.js';

import type { DailyRecapPreview } from '../../features/recaps/daily-recap-presentation.js';
import { PreviewDailyRecapService } from '../../features/recaps/preview-daily-recap.js';
import { renderDailyRecapDeliveryContent } from '../../features/recaps/send-daily-recap.js';
import { createDailyRecapEmbeds } from './daily-recap-embed-presentation.js';

const RECAP_COMMAND_NAME = 'recap';
const PREVIEW_SUBCOMMAND_NAME = 'preview';
const SEND_SUBCOMMAND_NAME = 'send';
const CONFIGURE_SUBCOMMAND_NAME = 'configure';
const MAX_EMBED_DESCRIPTION_LENGTH = 4_096;
const MAX_EMBEDS_PER_MESSAGE = 10;

export const dailyRecapPreviewCommandDefinitions = [
  new SlashCommandBuilder()
    .setName(RECAP_COMMAND_NAME)
    .setDescription('Configure, view, or send a daily recap.')
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName(PREVIEW_SUBCOMMAND_NAME)
        .setDescription('Privately preview the current daily recap without updating baselines.'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName(SEND_SUBCOMMAND_NAME)
        .setDescription('Prepare a daily recap for delivery after confirmation.'),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName(CONFIGURE_SUBCOMMAND_NAME)
        .setDescription('Configure this server’s automatic daily recap.')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Channel where daily recaps are posted.')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('time')
            .setDescription('Daily local time in 24-hour HH:mm format.')
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('timezone')
            .setDescription('IANA timezone, for example Europe/Helsinki.')
            .setRequired(true),
        )
        .addBooleanOption((option) =>
          option
            .setName('enabled')
            .setDescription('Whether automatic recap scheduling is enabled.')
            .setRequired(true),
        ),
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
  client: DiscordInteractionRegistrar,
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

export function dailyRecapPreviewEmbeds(preview: DailyRecapPreview): readonly EmbedBuilder[] {
  return createDailyRecapEmbeds({
    pages: splitPreviewContent(renderDailyRecapDeliveryContent(preview.presentation)),
    title: 'Daily recap preview',
  });
}

function splitPreviewContent(content: string): string[] {
  const pages: string[] = [];
  let page = '';
  for (const line of content.split('\n').flatMap(splitLongLine)) {
    const candidate = page === '' ? line : `${page}\n${line}`;
    if (candidate.length > MAX_EMBED_DESCRIPTION_LENGTH && page !== '') {
      pages.push(page);
      page = line;
    } else {
      page = candidate;
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
