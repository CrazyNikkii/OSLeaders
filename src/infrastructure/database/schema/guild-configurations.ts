import { pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import { guilds } from './guilds.js';

export const administrativeLogModes = ['standard', 'verbose'] as const;

export const administrativeLogMode = pgEnum('administrative_log_mode', administrativeLogModes);

export const guildConfigurations = pgTable('guild_configurations', {
  guildId: text('guild_id')
    .primaryKey()
    .references(() => guilds.guildId, { onDelete: 'cascade' }),
  botManagerRoleId: text('bot_manager_role_id'),
  competitionManagerRoleId: text('competition_manager_role_id'),
  administrativeLogChannelId: text('administrative_log_channel_id'),
  administrativeLogMode: administrativeLogMode('administrative_log_mode')
    .notNull()
    .default('standard'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
