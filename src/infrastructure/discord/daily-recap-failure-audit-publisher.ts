import type { Client } from 'discord.js';

import { shouldDeliverAdministrativeAuditEvent } from '../../features/audit/administrative-audit-policy.js';
import type { DailyRecapFailureAuditPublisher } from '../../features/recaps/report-daily-recap-failures.js';
import type { GuildConfigurationService } from '../../features/guild-configuration/guild-configuration-service.js';

const MAXIMUM_DISCORD_MESSAGE_LENGTH = 2_000;

export class DiscordDailyRecapFailureAuditPublisher implements DailyRecapFailureAuditPublisher {
  public constructor(
    private readonly client: Pick<Client, 'guilds'>,
    private readonly configuration: Pick<GuildConfigurationService, 'getOrCreate'>,
  ) {}

  public async publish(guildId: string, content: string): Promise<void> {
    const configuration = await this.configuration.getOrCreate(guildId);
    if (
      configuration.administrativeLogChannelId === null ||
      !shouldDeliverAdministrativeAuditEvent(
        {
          guildId,
          occurredAt: new Date(),
          operation: 'daily_recap.account_fetch_failures',
          severity: 'warn',
          type: 'recap-or-scheduling-failure',
        },
        configuration.administrativeLogMode,
      )
    ) {
      return;
    }

    const guild = await this.client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(configuration.administrativeLogChannelId);
    if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
      throw new Error('The configured administrative log channel is not available.');
    }
    for (const chunk of splitDailyRecapFailureAuditContent(content)) {
      await channel.send({ content: chunk });
    }
  }
}

export function splitDailyRecapFailureAuditContent(content: string): readonly string[] {
  const [heading, ...lines] = content.split('\n');
  if (heading === undefined || heading.length >= MAXIMUM_DISCORD_MESSAGE_LENGTH) {
    throw new Error('Daily recap failure audit heading exceeds the Discord message limit.');
  }

  const chunks: string[] = [];
  let current = heading;
  for (const originalLine of lines) {
    let line = originalLine;
    while (line.length > 0) {
      const candidate = `${current}\n${line}`;
      if (candidate.length <= MAXIMUM_DISCORD_MESSAGE_LENGTH) {
        current = candidate;
        line = '';
        continue;
      }
      if (current !== heading) {
        chunks.push(current);
        current = heading;
        continue;
      }
      const availableLength = MAXIMUM_DISCORD_MESSAGE_LENGTH - current.length - 1;
      current = `${current}\n${line.slice(0, availableLength)}`;
      chunks.push(current);
      current = heading;
      line = line.slice(availableLength);
    }
  }
  chunks.push(current);
  return chunks;
}
