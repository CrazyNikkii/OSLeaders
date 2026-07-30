import { describe, expect, it, vi } from 'vitest';

const { loadEnvironmentFileIfPresent } = vi.hoisted(() => ({
  loadEnvironmentFileIfPresent: vi.fn(),
}));

vi.mock('../src/infrastructure/config/environment-file.js', () => ({
  loadEnvironmentFileIfPresent,
}));

import {
  loadRuntimeConfiguration,
  parseRuntimeConfiguration,
} from '../src/infrastructure/config/runtime-environment.js';

const VALID_ENVIRONMENT: NodeJS.ProcessEnv = {
  DATABASE_POOL_MAX: '4',
  DATABASE_URL: 'postgresql://osleaders_dev:private@localhost:5432/osleaders_dev',
  DISCORD_APPLICATION_ID: '123456789012345678',
  DISCORD_DEVELOPMENT_GUILD_ID: '987654321098765432',
  DISCORD_TOKEN: 'private-development-token',
  LOG_LEVEL: 'info',
  NODE_ENV: 'development',
};

describe('runtime environment configuration', () => {
  it('loads the optional .env file before parsing process configuration', () => {
    const originalValues = new Map(
      Object.keys(VALID_ENVIRONMENT).map((name) => [name, process.env[name]]),
    );

    try {
      Object.assign(process.env, VALID_ENVIRONMENT);

      expect(loadRuntimeConfiguration()).toEqual(parseRuntimeConfiguration(VALID_ENVIRONMENT));
      expect(loadEnvironmentFileIfPresent).toHaveBeenCalledOnce();
      expect(loadEnvironmentFileIfPresent).toHaveBeenCalledWith('.env');
    } finally {
      for (const [name, value] of originalValues) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it('parses the complete application configuration without converting Discord IDs', () => {
    expect(parseRuntimeConfiguration(VALID_ENVIRONMENT)).toEqual({
      database: {
        connectionString: 'postgresql://osleaders_dev:private@localhost:5432/osleaders_dev',
        poolMax: 4,
      },
      discord: {
        applicationId: '123456789012345678',
        developmentGuildId: '987654321098765432',
        token: 'private-development-token',
      },
      environment: 'development',
      logLevel: 'info',
    });
  });

  it('accepts production as a runtime environment', () => {
    expect(
      parseRuntimeConfiguration({
        ...VALID_ENVIRONMENT,
        NODE_ENV: 'production',
      }).environment,
    ).toBe('production');
  });

  it('allows production configuration without a development guild', () => {
    expect(
      parseRuntimeConfiguration({
        ...VALID_ENVIRONMENT,
        DISCORD_DEVELOPMENT_GUILD_ID: undefined,
        NODE_ENV: 'production',
      }).discord.developmentGuildId,
    ).toBeUndefined();
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)('accepts the %s log level', (logLevel) => {
    expect(
      parseRuntimeConfiguration({
        ...VALID_ENVIRONMENT,
        LOG_LEVEL: logLevel,
      }).logLevel,
    ).toBe(logLevel);
  });

  it.each([
    'DATABASE_POOL_MAX',
    'DATABASE_URL',
    'DISCORD_APPLICATION_ID',
    'DISCORD_TOKEN',
    'LOG_LEVEL',
    'NODE_ENV',
  ])('rejects a missing %s value', (name) => {
    expect(() => {
      parseRuntimeConfiguration({
        ...VALID_ENVIRONMENT,
        [name]: undefined,
      });
    }).toThrow(`${name} must be set.`);
  });

  it.each(['', '   '])('rejects a blank Discord token', (token) => {
    expect(() => {
      parseRuntimeConfiguration({
        ...VALID_ENVIRONMENT,
        DISCORD_TOKEN: token,
      });
    }).toThrow('DISCORD_TOKEN must be set.');
  });

  it.each([
    ['DISCORD_APPLICATION_ID', 'REPLACE_WITH_DEVELOPMENT_APPLICATION_ID'],
    ['DISCORD_TOKEN', 'REPLACE_WITH_DEVELOPMENT_BOT_TOKEN'],
    ['LOG_LEVEL', 'REPLACE_WITH_LOG_LEVEL'],
  ] as const)('rejects the example placeholder for %s', (name, value) => {
    expect(() => {
      parseRuntimeConfiguration({
        ...VALID_ENVIRONMENT,
        [name]: value,
      });
    }).toThrow(`${name} must not use the example placeholder.`);
  });

  it.each(['abc', '123.5', '-123'])(
    'rejects the invalid Discord application ID %s without echoing it',
    (applicationId) => {
      let thrownError: unknown;

      try {
        parseRuntimeConfiguration({
          ...VALID_ENVIRONMENT,
          DISCORD_APPLICATION_ID: applicationId,
        });
      } catch (error: unknown) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(Error);
      expect((thrownError as Error).message).toBe(
        'DISCORD_APPLICATION_ID must contain decimal digits only.',
      );
      expect((thrownError as Error).message).not.toContain(applicationId);
    },
  );

  it.each(['abc', '123.5', '-123'])(
    'rejects the invalid development guild ID %s without echoing it',
    (guildId) => {
      expect(() => {
        parseRuntimeConfiguration({
          ...VALID_ENVIRONMENT,
          DISCORD_DEVELOPMENT_GUILD_ID: guildId,
        });
      }).toThrow('DISCORD_DEVELOPMENT_GUILD_ID must contain decimal digits only.');
    },
  );

  it.each([undefined, 'test', 'staging'])(
    'rejects NODE_ENV=%s for application startup',
    (nodeEnvironment) => {
      expect(() => {
        parseRuntimeConfiguration({
          ...VALID_ENVIRONMENT,
          NODE_ENV: nodeEnvironment,
        });
      }).toThrow(
        nodeEnvironment === undefined
          ? 'NODE_ENV must be set.'
          : 'NODE_ENV must be exactly development or production.',
      );
    },
  );

  it.each(['INFO', 'trace', 'silent'])('rejects the unsupported log level %s', (logLevel) => {
    expect(() => {
      parseRuntimeConfiguration({
        ...VALID_ENVIRONMENT,
        LOG_LEVEL: logLevel,
      });
    }).toThrow('LOG_LEVEL must be one of: debug, info, warn, error.');
  });
});
