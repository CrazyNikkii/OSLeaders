import {
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import type { DiscordInteractionRegistrar } from './discord-interaction-dispatcher.js';

import type { ConfigureCompetitionChannelService } from '../../features/competitions/configure-competition-channel.js';

export class DiscordCompetitionChannelConfigurationCommandAdapter {
  public constructor(
    private readonly configuration: Pick<ConfigureCompetitionChannelService, 'configure'>,
  ) {}

  public async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    if (
      interaction.commandName !== 'competition' ||
      interaction.options.getSubcommand() !== 'configure-channel'
    )
      return;
    if (interaction.guildId === null) {
      await interaction.reply({
        content: 'This command can only be used in a Discord server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await this.configuration.configure({
      channelId: interaction.options.getChannel('channel', true).id,
      guildId: interaction.guildId,
      hasAdministratorPermission:
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
      memberRoleIds: memberRoleIds(interaction),
    });
    await interaction.editReply({
      content:
        result.kind === 'configured'
          ? `Finished competition results will be posted in <#${result.configuration.competitionChannelId}>.`
          : 'You need Discord Administrator permission or the bot-manager role to configure the competition channel.',
    });
  }
}

export function bindDiscordCompetitionChannelConfigurationCommandAdapter(
  client: DiscordInteractionRegistrar,
  adapter: DiscordCompetitionChannelConfigurationCommandAdapter,
  reportUnexpectedError: (error: unknown) => void,
  shouldHandleInteraction: (interaction: Interaction) => boolean = () => true,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!shouldHandleInteraction(interaction) || !interaction.isChatInputCommand()) return;
    void adapter.handle(interaction).catch(reportUnexpectedError);
  });
}

function memberRoleIds(interaction: ChatInputCommandInteraction): readonly string[] {
  const roles = interaction.member?.roles;
  return roles === undefined ? [] : Array.isArray(roles) ? roles : [...roles.cache.keys()];
}
