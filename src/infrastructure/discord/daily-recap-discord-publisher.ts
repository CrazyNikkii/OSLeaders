import type { Client } from 'discord.js';

import type {
  DailyRecapPublisher,
  PendingDailyRecapDelivery,
} from '../../features/recaps/deliver-daily-recap.js';

const CHUNK_LENGTH = 1_900;

export class DiscordDailyRecapPublisher implements DailyRecapPublisher {
  public constructor(private readonly client: Pick<Client, 'guilds'>) {}

  public async publish(delivery: PendingDailyRecapDelivery): Promise<{ discordMessageId: string }> {
    const guild = await this.client.guilds.fetch(delivery.guildId);
    const channel = await guild.channels.fetch(delivery.channelId);
    if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
      throw new Error('The configured daily recap channel is not available for delivery.');
    }
    let message: { id: string } | undefined;
    for (const content of splitDailyRecapContent(
      delivery.content,
      delivery.attemptCount,
      delivery.recapRunId,
    )) {
      const sent = await channel.send({ content });
      message ??= sent;
    }
    if (message === undefined) {
      throw new Error('The daily recap did not contain content to deliver.');
    }
    return { discordMessageId: message.id };
  }
}

export function splitDailyRecapContent(
  content: string,
  attemptCount: number,
  recapRunId: string,
): readonly string[] {
  const chunks = splitAtLineBoundaries(content, CHUNK_LENGTH);
  return chunks.map(
    (chunk, index) =>
      `**Daily recap - delivery ${recapRunId}, part ${index + 1}/${chunks.length}${attemptCount > 1 ? `, retry ${attemptCount}` : ''}**\n${chunk}`,
  );
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
