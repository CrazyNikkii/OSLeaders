import {
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from 'discord.js';

import type { ConfigureDailyRecapService } from '../../features/recaps/configure-daily-recap.js';

export class DiscordDailyRecapConfigurationCommandAdapter {
  public constructor(
    private readonly configuration: Pick<ConfigureDailyRecapService, 'configure'>,
  ) {}

  public async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    if (
      interaction.commandName !== 'recap' ||
      interaction.options.getSubcommand() !== 'configure'
    ) {
      return;
    }
    if (interaction.guildId === null) {
      await interaction.reply({
        content: 'This command can only be used in a Discord server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await this.configuration.configure({
      enabled: interaction.options.getBoolean('enabled', true),
      guildId: interaction.guildId,
      hasAdministratorPermission:
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
      memberRoleIds: memberRoleIds(interaction),
      recapChannelId: interaction.options.getChannel('channel', true).id,
      recapLocalTime: interaction.options.getString('time', true),
      timezone: interaction.options.getString('timezone', true),
    });
    await interaction.editReply({ content: resultMessage(result) });
  }
}

export function bindDiscordDailyRecapConfigurationCommandAdapter(
  client: Client,
  adapter: DiscordDailyRecapConfigurationCommandAdapter,
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

function memberRoleIds(interaction: ChatInputCommandInteraction): readonly string[] {
  const roles = interaction.member?.roles;
  return roles === undefined ? [] : Array.isArray(roles) ? roles : [...roles.cache.keys()];
}

function resultMessage(
  result: Awaited<ReturnType<ConfigureDailyRecapService['configure']>>,
): string {
  switch (result.kind) {
    case 'configured':
      return result.configuration.recapEnabled
        ? `Automatic daily recaps are enabled for <#${result.configuration.recapChannelId}> at ${result.configuration.recapLocalTime} (${result.configuration.timezone}).`
        : 'Automatic daily recaps are disabled for this server.';
    case 'forbidden':
      return 'You need Discord Administrator permission or the bot-manager role to configure daily recaps.';
    case 'invalid_local_time':
      return 'Use an unambiguous daily local time in HH:mm format; daylight-saving transition times are not supported.';
    case 'invalid_timezone':
      return 'Use a valid IANA timezone, for example Europe/Helsinki.';
  }
}
