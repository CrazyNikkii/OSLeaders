import { eq } from 'drizzle-orm';

import type {
  GuildConfiguration,
  GuildConfigurationRepository,
  GuildConfigurationUpdate,
} from '../../features/guild-configuration/guild-configuration-service.js';
import type { Database, Transaction } from './connection.js';
import { guildConfigurations, guilds } from './schema/index.js';

export class PostgresGuildConfigurationRepository implements GuildConfigurationRepository {
  public constructor(private readonly database: Database) {}

  public async getOrCreate(guildId: string): Promise<GuildConfiguration> {
    return this.database.transaction(async (transaction) => {
      await transaction.insert(guilds).values({ guildId }).onConflictDoNothing();
      const [configuration] = await transaction
        .insert(guildConfigurations)
        .values({ guildId })
        .onConflictDoNothing()
        .returning();

      if (configuration !== undefined) {
        return toGuildConfiguration(configuration);
      }

      const existingConfiguration = await this.selectConfiguration(transaction, guildId);
      if (existingConfiguration === undefined) {
        throw new Error('Guild configuration was not created.');
      }

      return toGuildConfiguration(existingConfiguration);
    });
  }

  public async update(
    guildId: string,
    update: GuildConfigurationUpdate,
  ): Promise<GuildConfiguration> {
    await this.getOrCreate(guildId);
    const [configuration] = await this.database
      .update(guildConfigurations)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(guildConfigurations.guildId, guildId))
      .returning();

    if (configuration === undefined) {
      throw new Error('Guild configuration was not found after creation.');
    }

    return toGuildConfiguration(configuration);
  }

  private async selectConfiguration(database: Database | Transaction, guildId: string) {
    const [configuration] = await database
      .select()
      .from(guildConfigurations)
      .where(eq(guildConfigurations.guildId, guildId));

    return configuration;
  }
}

function toGuildConfiguration(
  configuration: typeof guildConfigurations.$inferSelect,
): GuildConfiguration {
  return {
    administrativeLogChannelId: configuration.administrativeLogChannelId,
    administrativeLogMode: configuration.administrativeLogMode,
    botManagerRoleId: configuration.botManagerRoleId,
    competitionManagerRoleId: configuration.competitionManagerRoleId,
    guildId: configuration.guildId,
    modeEmojis: configuration.modeEmojis,
  };
}
