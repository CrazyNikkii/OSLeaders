import type { Client } from 'discord.js';

import type {
  CompetitionResultPublisher,
  PendingCompetitionResultDelivery,
} from '../../features/competitions/deliver-competition-result.js';
import type { CompetitionResultsHistoryResult } from '../../features/competitions/competition-results-history.js';
import { competitionResultsHistoryEmbeds } from './competition-results-history-command.js';

export class DiscordCompetitionResultPublisher implements CompetitionResultPublisher {
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
    delivery: PendingCompetitionResultDelivery,
    result: Extract<
      CompetitionResultsHistoryResult,
      { kind: 'finished_result' | 'cancelled_result' }
    >,
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
    let message: { id: string } | undefined;
    const embeds = result.kind === 'finished_result' ? competitionResultsHistoryEmbeds(result) : [];
    for (const batch of chunk(embeds, 10)) {
      const sent = await channel.send({
        allowedMentions: roleId === undefined ? { parse: [] } : { roles: [roleId] },
        embeds: batch,
        ...(message === undefined && result.kind === 'cancelled_result'
          ? {
              content: `${roleId === undefined ? '' : `<@&${roleId}> `}Competition **${result.displayName}** was cancelled.`,
            }
          : message === undefined && roleId !== undefined
            ? { content: `<@&${roleId}>` }
            : {}),
      });
      message ??= sent;
    }
    if (message === undefined && result.kind === 'cancelled_result') {
      message = await channel.send({
        content: `Competition **${result.displayName}** was cancelled.`,
        allowedMentions: { parse: [] },
      });
    }
    if (message === undefined)
      throw new Error('The competition result did not contain content to deliver.');
    return { discordMessageId: message.id };
  }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    chunks.push(items.slice(index, index + size));
  return chunks;
}
