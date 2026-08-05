import { describe, expect, it } from 'vitest';

import type { RuntimeConfiguration } from '../src/infrastructure/config/runtime-environment.js';
import {
  registerDiscordCommands,
  type DevelopmentCommandRegistrar,
} from '../src/infrastructure/discord/development-command-registration.js';

describe('development Discord command registration', () => {
  it('registers account, lookup, and leaderboard commands in the configured development guild', async () => {
    const registrar = new RecordingRegistrar();

    await registerDiscordCommands(configuration(), registrar);

    expect(registrar.requests).toEqual([
      expect.objectContaining({
        applicationId: 'application-one',
        guildId: 'development-guild-one',
      }),
    ]);
    expect(registrar.requests[0]?.commands).toEqual([
      expect.objectContaining({ name: 'account' }),
      expect.objectContaining({ name: 'skill' }),
      expect.objectContaining({ name: 'one-time-skill' }),
      expect.objectContaining({ name: 'one-time-boss' }),
      expect.objectContaining({ name: 'skill-leaderboard' }),
      expect.objectContaining({ name: 'boss-leaderboard' }),
      expect.objectContaining({ name: 'boss' }),
      expect.objectContaining({ name: 'recap' }),
    ]);
  });

  it('registers the production command set in its separate configured guild', async () => {
    const registrar = new RecordingRegistrar();

    await registerDiscordCommands(
      configuration({
        discord: { ...configuration().discord, guildId: 'production-guild-one' },
        environment: 'production',
      }),
      registrar,
    );

    expect(registrar.requests).toEqual([
      expect.objectContaining({ guildId: 'production-guild-one' }),
    ]);
  });
});

class RecordingRegistrar implements DevelopmentCommandRegistrar {
  public readonly requests: {
    applicationId: string;
    commands: readonly object[];
    guildId: string;
  }[] = [];

  public put(applicationId: string, guildId: string, commands: readonly object[]): Promise<void> {
    this.requests.push({ applicationId, commands, guildId });
    return Promise.resolve();
  }
}

function configuration(overrides: Partial<RuntimeConfiguration> = {}): RuntimeConfiguration {
  return {
    database: { connectionString: 'postgresql://localhost/osleaders_dev', poolMax: 4 },
    discord: {
      applicationId: 'application-one',
      guildId: 'development-guild-one',
      token: 'token-one',
    },
    environment: 'development',
    logLevel: 'info',
    ...overrides,
  };
}
