import { boolean, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

import { guilds } from './guilds.js';

export const guildMemberPresences = pgTable(
  'guild_member_presences',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.guildId, { onDelete: 'cascade' }),
    discordUserId: text('discord_user_id').notNull(),
    isPresent: boolean('is_present').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.discordUserId] })],
);
