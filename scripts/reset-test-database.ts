import { Pool } from 'pg';

import {
  assertTestResetEnvironment,
  loadTestDatabaseConfiguration,
} from '../src/infrastructure/config/database-environment.js';

const RESET_CONFIRMATION = 'osleaders_test';

async function main(): Promise<void> {
  assertTestResetEnvironment(process.env);
  assertResetConfirmation(process.argv.slice(2));

  const configuration = loadTestDatabaseConfiguration();
  const pool = new Pool({ connectionString: configuration.connectionString, max: 1 });

  try {
    const result = await pool.query<{ current_database: string }>(
      'SELECT current_database() AS current_database',
    );

    if (result.rows[0]?.current_database !== RESET_CONFIRMATION) {
      throw new Error('Refusing to reset a database other than osleaders_test.');
    }

    await pool.query(
      'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;',
    );
  } finally {
    await pool.end();
  }
}

function assertResetConfirmation(argumentsList: string[]): void {
  const confirmationIndex = argumentsList.indexOf('--confirm');

  if (confirmationIndex === -1 || argumentsList[confirmationIndex + 1] !== RESET_CONFIRMATION) {
    throw new Error('Use --confirm osleaders_test to reset the test database.');
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'The test database reset failed.';
  console.error(message);
  process.exitCode = 1;
});
