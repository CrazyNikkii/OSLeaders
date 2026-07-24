import { defineConfig } from 'drizzle-kit';

import { loadTestDatabaseConfiguration } from './src/infrastructure/config/database-environment.js';

const configuration = loadTestDatabaseConfiguration();

export default defineConfig({
  dbCredentials: { url: configuration.connectionString },
  dialect: 'postgresql',
  out: './drizzle',
  schema: './src/infrastructure/database/schema/index.ts',
});
