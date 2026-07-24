import { loadEnvironmentFileIfPresent } from './environment-file.js';

const DEVELOPMENT_DATABASE_NAME = 'osleaders_dev';
const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const TEST_DATABASE_NAME = 'osleaders_test';

export interface DatabaseConfiguration {
  connectionString: string;
  poolMax: number;
}

export interface TestDatabaseConfiguration {
  connectionString: string;
}

export function loadRuntimeDatabaseConfiguration(): DatabaseConfiguration {
  loadEnvironmentFileIfPresent('.env');

  return parseRuntimeDatabaseConfiguration(process.env);
}

export function loadDevelopmentMigrationConfiguration(): DatabaseConfiguration {
  loadEnvironmentFileIfPresent('.env');

  const configuration = parseRuntimeDatabaseConfiguration(process.env);
  assertDevelopmentMigrationEnvironment(process.env);

  return configuration;
}

export function parseRuntimeDatabaseConfiguration(
  environment: NodeJS.ProcessEnv,
): DatabaseConfiguration {
  return {
    connectionString: requiredEnvironmentValue(environment, 'DATABASE_URL'),
    poolMax: parsePositiveInteger(
      requiredEnvironmentValue(environment, 'DATABASE_POOL_MAX'),
      'DATABASE_POOL_MAX',
    ),
  };
}

export function loadTestDatabaseConfiguration(): TestDatabaseConfiguration {
  loadEnvironmentFileIfPresent('.env.test');

  return parseTestDatabaseConfiguration(process.env);
}

export function parseTestDatabaseConfiguration(
  environment: NodeJS.ProcessEnv,
): TestDatabaseConfiguration {
  const connectionString = requiredEnvironmentValue(environment, 'DATABASE_TEST_URL');
  assertSafeTestDatabaseUrl(connectionString);

  return { connectionString };
}

export function assertSafeTestDatabaseUrl(connectionString: string): void {
  assertSafeLocalDatabaseUrl(connectionString, 'DATABASE_TEST_URL', TEST_DATABASE_NAME);
}

export function assertDevelopmentMigrationEnvironment(environment: NodeJS.ProcessEnv): void {
  if (environment.NODE_ENV !== 'development') {
    throw new Error('Development migrations require NODE_ENV to be exactly development.');
  }

  assertSafeLocalDatabaseUrl(
    requiredEnvironmentValue(environment, 'DATABASE_URL'),
    'DATABASE_URL',
    DEVELOPMENT_DATABASE_NAME,
  );
}

export function assertTestResetEnvironment(environment: NodeJS.ProcessEnv): void {
  if (environment.NODE_ENV !== 'test') {
    throw new Error('The test database reset requires NODE_ENV to be exactly test.');
  }
}

function assertSafeLocalDatabaseUrl(
  connectionString: string,
  environmentVariableName: string,
  expectedDatabaseName: string,
): void {
  let databaseUrl: URL;

  try {
    databaseUrl = new URL(connectionString);
  } catch {
    throw new Error(`${environmentVariableName} must be a valid PostgreSQL connection URL.`);
  }

  if (databaseUrl.protocol !== 'postgresql:' && databaseUrl.protocol !== 'postgres:') {
    throw new Error(`${environmentVariableName} must use the postgresql protocol.`);
  }

  const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));

  if (databaseName !== expectedDatabaseName) {
    throw new Error(`${environmentVariableName} must target exactly ${expectedDatabaseName}.`);
  }

  if (!LOCAL_DATABASE_HOSTS.has(databaseUrl.hostname)) {
    throw new Error(`${environmentVariableName} must target a local PostgreSQL host.`);
  }
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];

  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} must be set.`);
  }

  return value;
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }

  const parsedValue = Number(value);

  if (!Number.isSafeInteger(parsedValue) || parsedValue < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsedValue;
}
