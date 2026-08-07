import { type EmbedBuilder, type Client } from 'discord.js';

import type {
  DailyRecapPublisher,
  PendingDailyRecapDelivery,
} from '../../features/recaps/deliver-daily-recap.js';
import { createDailyRecapEmbeds } from './daily-recap-embed-presentation.js';

const MAXIMUM_EMBED_DESCRIPTION_LENGTH = 4_000;

export class DiscordDailyRecapPublisher implements DailyRecapPublisher {
  public constructor(private readonly client: Pick<Client, 'guilds'>) {}

  public async publish(delivery: PendingDailyRecapDelivery): Promise<{ discordMessageId: string }> {
    const guild = await this.client.guilds.fetch(delivery.guildId);
    const channel = await guild.channels.fetch(delivery.channelId);
    if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
      throw new Error('The configured daily recap channel is not available for delivery.');
    }
    let message: { id: string } | undefined;
    for (const embed of dailyRecapDeliveryEmbeds(
      delivery.content,
      delivery.attemptCount,
      delivery.recapRunId,
    )) {
      const sent = await channel.send({ embeds: [embed] });
      message ??= sent;
    }
    if (message === undefined) {
      throw new Error('The daily recap did not contain content to deliver.');
    }
    return { discordMessageId: message.id };
  }
}

export function splitDailyRecapContent(content: string): readonly string[] {
  return splitAtLineBoundaries(content, MAXIMUM_EMBED_DESCRIPTION_LENGTH);
}

export function dailyRecapDeliveryEmbeds(
  content: string,
  attemptCount: number,
  recapRunId: string,
): readonly EmbedBuilder[] {
  const pages = splitDailyRecapContent(content);
  return createDailyRecapEmbeds({
    footerDetails: [
      `Recap ${recapRunId.slice(0, 8)}`,
      ...(attemptCount > 1 ? [`Retry ${attemptCount}`] : []),
    ],
    pages,
    title: 'Daily recap',
  });
}

function splitAtLineBoundaries(content: string, maximumLength: number): readonly string[] {
  const chunks: string[] = [];
  let current = '';
  for (const originalLine of content.split('\n')) {
    let line = originalLine;
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length <= maximumLength) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      chunks.push(current);
    }
    while (line.length > maximumLength) {
      chunks.push(line.slice(0, maximumLength));
      line = line.slice(maximumLength);
    }
    current = line;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
