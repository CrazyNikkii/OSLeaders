import { describe, expect, it } from 'vitest';

import {
  GuildConfigurationService,
  type GuildConfiguration,
  type GuildConfigurationRepository,
  type GuildConfigurationUpdate,
} from '../src/features/guild-configuration/guild-configuration-service.js';

describe('guild configuration service', () => {
  it('uses a guild-scoped repository for reads and updates', async () => {
    const repository = new StubGuildConfigurationRepository();
    const service = new GuildConfigurationService(repository);

    await expect(service.getOrCreate('guild-one')).resolves.toEqual(
      defaultConfiguration('guild-one'),
    );
    await expect(
      service.update('guild-one', {
        administrativeLogMode: 'verbose',
        botManagerRoleId: 'bot-manager-role',
      }),
    ).resolves.toEqual({
      ...defaultConfiguration('guild-one'),
      administrativeLogMode: 'verbose',
      botManagerRoleId: 'bot-manager-role',
    });
    await expect(service.getOrCreate('guild-two')).resolves.toEqual(
      defaultConfiguration('guild-two'),
    );

    expect(repository.updatedGuildIds).toEqual(['guild-one']);
    expect(repository.configurations.get('guild-two')).toEqual(defaultConfiguration('guild-two'));
  });
});

class StubGuildConfigurationRepository implements GuildConfigurationRepository {
  public readonly configurations = new Map<string, GuildConfiguration>();
  public readonly updatedGuildIds: string[] = [];

  public getOrCreate(guildId: string): Promise<GuildConfiguration> {
    const configuration = this.configurations.get(guildId) ?? defaultConfiguration(guildId);
    this.configurations.set(guildId, configuration);
    return Promise.resolve(configuration);
  }

  public async update(
    guildId: string,
    update: GuildConfigurationUpdate,
  ): Promise<GuildConfiguration> {
    const configuration = await this.getOrCreate(guildId);
    const updatedConfiguration = { ...configuration, ...update };
    this.configurations.set(guildId, updatedConfiguration);
    this.updatedGuildIds.push(guildId);
    return updatedConfiguration;
  }
}

function defaultConfiguration(guildId: string): GuildConfiguration {
  return {
    administrativeLogChannelId: null,
    administrativeLogMode: 'standard',
    botManagerRoleId: null,
    competitionManagerRoleId: null,
    guildId,
    modeEmojis: {},
  };
}
