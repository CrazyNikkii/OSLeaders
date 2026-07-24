import { describe, expect, it } from 'vitest';

import type {
  GuildConfiguration,
  GuildConfigurationRepository,
  GuildConfigurationUpdate,
} from '../src/features/guild-configuration/guild-configuration-service.js';
import { GuildPermissionService } from '../src/features/guild-configuration/guild-permission-service.js';

describe('guild permission service', () => {
  it('authorizes a Discord administrator to manage accounts and competitions', async () => {
    const service = new GuildPermissionService(new StubGuildConfigurationRepository());

    await expect(
      service.evaluate({
        guildId: 'guild-one',
        hasAdministratorPermission: true,
        memberRoleIds: [],
      }),
    ).resolves.toEqual({
      canManageAccounts: true,
      canManageCompetitions: true,
    });
  });

  it('limits a bot-manager role to account administration', async () => {
    const service = new GuildPermissionService(
      new StubGuildConfigurationRepository({
        botManagerRoleId: 'bot-manager-role',
        competitionManagerRoleId: 'competition-manager-role',
      }),
    );

    await expect(
      service.evaluate({
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        memberRoleIds: ['bot-manager-role'],
      }),
    ).resolves.toEqual({
      canManageAccounts: true,
      canManageCompetitions: false,
    });
  });

  it('limits a competition-manager role to competition management', async () => {
    const service = new GuildPermissionService(
      new StubGuildConfigurationRepository({
        botManagerRoleId: 'bot-manager-role',
        competitionManagerRoleId: 'competition-manager-role',
      }),
    );

    await expect(
      service.evaluate({
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        memberRoleIds: ['competition-manager-role'],
      }),
    ).resolves.toEqual({
      canManageAccounts: false,
      canManageCompetitions: true,
    });
  });

  it('does not authorize unmatched or unconfigured roles', async () => {
    const service = new GuildPermissionService(new StubGuildConfigurationRepository());

    await expect(
      service.evaluate({
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        memberRoleIds: ['unrelated-role'],
      }),
    ).resolves.toEqual({
      canManageAccounts: false,
      canManageCompetitions: false,
    });
  });

  it('uses only the requesting guild configuration', async () => {
    const repository = new StubGuildConfigurationRepository();
    repository.configurations.set('guild-one', {
      ...defaultConfiguration('guild-one'),
      botManagerRoleId: 'guild-one-manager',
    });
    repository.configurations.set('guild-two', {
      ...defaultConfiguration('guild-two'),
      botManagerRoleId: 'guild-two-manager',
    });
    const service = new GuildPermissionService(repository);

    await expect(
      service.evaluate({
        guildId: 'guild-two',
        hasAdministratorPermission: false,
        memberRoleIds: ['guild-one-manager'],
      }),
    ).resolves.toEqual({
      canManageAccounts: false,
      canManageCompetitions: false,
    });
  });
});

class StubGuildConfigurationRepository implements GuildConfigurationRepository {
  public readonly configurations = new Map<string, GuildConfiguration>();

  public constructor(initialConfiguration?: GuildConfigurationUpdate) {
    if (initialConfiguration !== undefined) {
      this.configurations.set('guild-one', {
        ...defaultConfiguration('guild-one'),
        ...initialConfiguration,
      });
    }
  }

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
  };
}
