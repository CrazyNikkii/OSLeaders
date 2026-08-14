import { EmbedBuilder, type Client } from 'discord.js';

import type {
  CompetitionStartPublisher,
  PendingCompetitionStartDelivery,
} from '../../features/competitions/deliver-competition-start-announcement.js';
import { OSLEADERS_EMBED_COLOR } from './discord-embed-presentation.js';

export class DiscordCompetitionStartAnnouncer implements CompetitionStartPublisher {
  public constructor(
    private readonly client: Pick<Client, 'guilds'>,
    private readonly roles?: {
      findActiveRoleId(request: {
        competitionId: string;
        guildId: string;
      }): Promise<string | undefined>;
    },
  ) {}

  public async publish(
    delivery: PendingCompetitionStartDelivery,
  ): Promise<{ discordMessageId: string }> {
    const guild = await this.client.guilds.fetch(delivery.guildId);
    const channel = await guild.channels.fetch(delivery.channelId);
    if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
      throw new Error('The configured competition channel is not available for delivery.');
    }
    const roleId =
      delivery.attemptCount === 1
        ? await this.roles?.findActiveRoleId({
            competitionId: delivery.competitionId,
            guildId: delivery.guildId,
          })
        : undefined;
    const message = await channel.send({
      allowedMentions: roleId === undefined ? { parse: [] } : { roles: [roleId] },
      ...(roleId === undefined ? {} : { content: `<@&${roleId}>` }),
      embeds: [competitionStartAnnouncementEmbed(delivery)],
    });
    return { discordMessageId: message.id };
  }
}

export function competitionStartAnnouncementEmbed(
  announcement: Pick<PendingCompetitionStartDelivery, 'displayName' | 'endsAt' | 'metric'>,
): EmbedBuilder {
  const metric = `${announcement.metric.name} ${
    announcement.metric.kind === 'skill' ? 'XP' : 'KC'
  }`;
  const timing =
    announcement.endsAt === null
      ? 'Target race with no deadline.'
      : `Ends <t:${Math.floor(announcement.endsAt.getTime() / 1_000)}:R>.`;
  return new EmbedBuilder()
    .setColor(OSLEADERS_EMBED_COLOR)
    .setTitle('Competition started')
    .setDescription(`**${announcement.displayName}**\n\n**${metric}** - ${timing}`)
    .setFooter({ text: 'Competition announcement' });
}
