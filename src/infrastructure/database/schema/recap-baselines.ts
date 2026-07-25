import { foreignKey, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { guilds } from './guilds.js';
import { trackedAccounts } from './tracked-accounts.js';

export const recapBaselines = pgTable(
  'recap_baselines',
  {
    accountId: text('account_id').primaryKey(),
    bossKillCounts: jsonb('boss_kill_counts').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.guildId, { onDelete: 'cascade' }),
    skillExperience: jsonb('skill_experience').notNull(),
    skillLevels: jsonb('skill_levels').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.accountId, table.guildId],
      foreignColumns: [trackedAccounts.id, trackedAccounts.guildId],
      name: 'recap_baselines_account_guild_tracked_accounts_fk',
    }).onDelete('cascade'),
  ],
);
