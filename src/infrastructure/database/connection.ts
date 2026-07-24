import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { DatabaseConfiguration } from '../config/database-environment.js';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseConnection {
  database: Database;
  pool: Pool;
  close(): Promise<void>;
}

export function createDatabaseConnection(configuration: DatabaseConfiguration): DatabaseConnection {
  const pool = new Pool({
    connectionString: configuration.connectionString,
    max: configuration.poolMax,
  });
  const database = drizzle({ client: pool, schema });

  return {
    database,
    pool,
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export async function withTransaction<T>(
  database: Database,
  operation: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return database.transaction(operation);
}
