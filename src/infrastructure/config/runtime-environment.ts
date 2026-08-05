import {
  parseRuntimeDatabaseConfiguration,
  type DatabaseConfiguration,
} from './database-environment.js';
import { loadEnvironmentFileIfPresent } from './environment-file.js';
import {
  requiredConfiguredEnvironmentValue,
  requiredEnvironmentValue,
} from './environment-values.js';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const RUNTIME_ENVIRONMENTS = ['development', 'production'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type RuntimeEnvironment = (typeof RUNTIME_ENVIRONMENTS)[number];

export interface RuntimeConfiguration {
  database: DatabaseConfiguration;
  discord: {
    applicationId: string;
    guildId: string;
    token: string;
  };
  environment: RuntimeEnvironment;
  logLevel: LogLevel;
}

export function loadRuntimeConfiguration(): RuntimeConfiguration {
  loadEnvironmentFileIfPresent('.env');

  return parseRuntimeConfiguration(process.env);
}

export function parseRuntimeConfiguration(environment: NodeJS.ProcessEnv): RuntimeConfiguration {
  const runtimeEnvironment = parseRuntimeEnvironment(
    requiredEnvironmentValue(environment, 'NODE_ENV'),
  );

  return {
    database: parseRuntimeDatabaseConfiguration(environment),
    discord: {
      applicationId: parseDiscordApplicationId(
        requiredConfiguredEnvironmentValue(environment, 'DISCORD_APPLICATION_ID'),
      ),
      guildId: parseRuntimeGuildId(environment, runtimeEnvironment),
      token: requiredConfiguredEnvironmentValue(environment, 'DISCORD_TOKEN'),
    },
    environment: runtimeEnvironment,
    logLevel: parseLogLevel(requiredConfiguredEnvironmentValue(environment, 'LOG_LEVEL')),
  };
}

function parseRuntimeGuildId(
  environment: NodeJS.ProcessEnv,
  runtimeEnvironment: RuntimeEnvironment,
): string {
  const environmentVariableName =
    runtimeEnvironment === 'production'
      ? 'DISCORD_PRODUCTION_GUILD_ID'
      : 'DISCORD_DEVELOPMENT_GUILD_ID';

  return parseDiscordSnowflake(
    requiredConfiguredEnvironmentValue(environment, environmentVariableName),
    environmentVariableName,
  );
}

function parseDiscordApplicationId(value: string): string {
  return parseDiscordSnowflake(value, 'DISCORD_APPLICATION_ID');
}

function parseDiscordSnowflake(value: string, environmentVariableName: string): string {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${environmentVariableName} must contain decimal digits only.`);
  }

  return value;
}

function parseRuntimeEnvironment(value: string): RuntimeEnvironment {
  if (!isOneOf(value, RUNTIME_ENVIRONMENTS)) {
    throw new Error('NODE_ENV must be exactly development or production.');
  }

  return value;
}

function parseLogLevel(value: string): LogLevel {
  if (!isOneOf(value, LOG_LEVELS)) {
    throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}.`);
  }

  return value;
}

function isOneOf<const Values extends readonly string[]>(
  value: string,
  values: Values,
): value is Values[number] {
  return values.some((candidate) => candidate === value);
}
