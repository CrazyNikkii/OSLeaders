import { sql } from 'drizzle-orm';
import { boolean, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

import type { GuildModeEmojis } from '../../../features/guild-configuration/guild-configuration-service.js';
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
  modeEmojis: jsonb('mode_emojis')
    .$type<GuildModeEmojis>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  recapChannelId: text('recap_channel_id'),
  recapEnabled: boolean('recap_enabled').notNull().default(false),
  recapLocalTime: text('recap_local_time'),
  timezone: text('timezone').notNull().default('Europe/Helsinki'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
