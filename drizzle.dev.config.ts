import { defineConfig } from 'drizzle-kit';

import { loadDevelopmentMigrationConfiguration } from './src/infrastructure/config/database-environment.js';

const configuration = loadDevelopmentMigrationConfiguration();

export default defineConfig({
  dbCredentials: { url: configuration.connectionString },
  dialect: 'postgresql',
  out: './drizzle',
  schema: './src/infrastructure/database/schema/index.ts',
});
