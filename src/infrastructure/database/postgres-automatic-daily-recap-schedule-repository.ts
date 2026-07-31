import { and, eq, isNotNull } from 'drizzle-orm';

import type { AutomaticDailyRecapScheduleRepository } from '../../features/recaps/schedule-automatic-daily-recaps.js';
import type { GuildConfiguration } from '../../features/guild-configuration/guild-configuration-service.js';
import type { Database } from './connection.js';
import { dailyRecapRuns, guildConfigurations } from './schema/index.js';

export class PostgresAutomaticDailyRecapScheduleRepository implements AutomaticDailyRecapScheduleRepository {
  public constructor(private readonly database: Database) {}

  public async listEnabledRecapConfigurations(): Promise<readonly GuildConfiguration[]> {
    const configurations = await this.database
      .select()
      .from(guildConfigurations)
      .where(
        and(
          eq(guildConfigurations.recapEnabled, true),
          isNotNull(guildConfigurations.recapChannelId),
          isNotNull(guildConfigurations.recapLocalTime),
        ),
      );
    return configurations.map((configuration) => ({
      administrativeLogChannelId: configuration.administrativeLogChannelId,
      administrativeLogMode: configuration.administrativeLogMode,
      botManagerRoleId: configuration.botManagerRoleId,
      competitionManagerRoleId: configuration.competitionManagerRoleId,
      guildId: configuration.guildId,
      modeEmojis: configuration.modeEmojis,
      recapChannelId: configuration.recapChannelId,
      recapEnabled: configuration.recapEnabled,
      recapLocalTime: configuration.recapLocalTime,
      timezone: configuration.timezone,
    }));
  }

  public async createAutomaticRun(
    guildId: string,
    recapRunId: string,
    scheduledFor: Date,
  ): Promise<boolean> {
    const inserted = await this.database
      .insert(dailyRecapRuns)
      .values({
        guildId,
        id: recapRunId,
        scheduledFor,
        trigger: 'automatic',
      })
      .onConflictDoNothing()
      .returning({ id: dailyRecapRuns.id });
    return inserted.length === 1;
  }
}
