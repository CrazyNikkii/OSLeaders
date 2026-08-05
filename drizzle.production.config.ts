import { defineConfig } from 'drizzle-kit';

import { loadProductionMigrationConfiguration } from './src/infrastructure/config/database-environment.js';

const configuration = loadProductionMigrationConfiguration();

export default defineConfig({
  dbCredentials: { url: configuration.connectionString },
  dialect: 'postgresql',
  out: './drizzle',
  schema: './src/infrastructure/database/schema/index.ts',
});
