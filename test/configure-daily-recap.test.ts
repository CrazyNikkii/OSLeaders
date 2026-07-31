import { describe, expect, it } from 'vitest';

import {
  ConfigureDailyRecapService,
  type ConfigureDailyRecapRequest,
} from '../src/features/recaps/configure-daily-recap.js';
import type {
  GuildConfiguration,
  GuildConfigurationRepository,
} from '../src/features/guild-configuration/guild-configuration-service.js';

describe('daily recap configuration service', () => {
  it('authorizes bot managers and persists only the requesting guild configuration', async () => {
    const configurations = new ConfigurationRepository();
    const service = new ConfigureDailyRecapService(configurations, {
      evaluate: () => Promise.resolve(permissions(true)),
    });

    await expect(service.configure(request())).resolves.toMatchObject({
      configuration: {
        guildId: 'guild-one',
        recapChannelId: 'recap-channel',
        recapEnabled: true,
        recapLocalTime: '18:00',
        timezone: 'Europe/Helsinki',
      },
      kind: 'configured',
    });
    expect(configurations.configurations.get('guild-two')).toBeUndefined();
  });

  it('rejects unauthorized, malformed, and daylight-saving-transition configurations', async () => {
    const configurations = new ConfigurationRepository();
    const forbidden = new ConfigureDailyRecapService(configurations, {
      evaluate: () => Promise.resolve(permissions(false)),
    });
    const allowed = new ConfigureDailyRecapService(
      configurations,
      { evaluate: () => Promise.resolve(permissions(true)) },
      () => new Date('2026-01-01T12:00:00.000Z'),
    );

    await expect(forbidden.configure(request())).resolves.toEqual({ kind: 'forbidden' });
    await expect(allowed.configure(request({ recapLocalTime: '6pm' }))).resolves.toEqual({
      kind: 'invalid_local_time',
    });
    await expect(allowed.configure(request({ timezone: 'Not/A_Timezone' }))).resolves.toEqual({
      kind: 'invalid_timezone',
    });
    await expect(allowed.configure(request({ recapLocalTime: '03:30' }))).resolves.toEqual({
      kind: 'invalid_local_time',
    });
    expect(configurations.configurations).toEqual(new Map());
  });
});

class ConfigurationRepository implements GuildConfigurationRepository {
  public readonly configurations = new Map<string, GuildConfiguration>();

  public getOrCreate(guildId: string): Promise<GuildConfiguration> {
    const configuration = this.configurations.get(guildId) ?? defaultConfiguration(guildId);
    this.configurations.set(guildId, configuration);
    return Promise.resolve(configuration);
  }

  public async update(
    guildId: string,
    update: Partial<GuildConfiguration>,
  ): Promise<GuildConfiguration> {
    const configuration = { ...(await this.getOrCreate(guildId)), ...update };
    this.configurations.set(guildId, configuration);
    return configuration;
  }
}

function request(overrides: Partial<ConfigureDailyRecapRequest> = {}): ConfigureDailyRecapRequest {
  return {
    enabled: true,
    guildId: 'guild-one',
    hasAdministratorPermission: false,
    memberRoleIds: ['bot-manager'],
    recapChannelId: 'recap-channel',
    recapLocalTime: '18:00',
    timezone: 'Europe/Helsinki',
    ...overrides,
  };
}

function permissions(canManageAccounts: boolean) {
  return { canManageAccounts, canManageCompetitions: false };
}

function defaultConfiguration(guildId: string): GuildConfiguration {
  return {
    administrativeLogChannelId: null,
    administrativeLogMode: 'standard',
    botManagerRoleId: null,
    competitionManagerRoleId: null,
    guildId,
    modeEmojis: {},
    recapChannelId: null,
    recapEnabled: false,
    recapLocalTime: null,
    timezone: 'Europe/Helsinki',
  };
}
