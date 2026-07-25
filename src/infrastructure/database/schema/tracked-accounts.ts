import { sql } from 'drizzle-orm';
import {
  check,
  boolean,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { OSRS_ACCOUNT_MODES } from '../../hiscores/osrs-hiscore-catalog.js';
import { guilds } from './guilds.js';

export const accountAssociationTypes = ['linked', 'watchlist'] as const;

export const accountAssociationType = pgEnum('account_association_type', accountAssociationTypes);
export const osrsAccountMode = pgEnum('osrs_account_mode', OSRS_ACCOUNT_MODES);

export const trackedAccounts = pgTable(
  'tracked_accounts',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.guildId, { onDelete: 'cascade' }),
    displayUsername: text('display_username').notNull(),
    normalizedUsername: text('normalized_username').notNull(),
    accountMode: osrsAccountMode('account_mode').notNull(),
    associationType: accountAssociationType('association_type').notNull(),
    linkedDiscordUserId: text('linked_discord_user_id'),
    quotaOwnerDiscordUserId: text('quota_owner_discord_user_id').notNull(),
    registeredByDiscordUserId: text('registered_by_discord_user_id').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tracked_accounts_guild_normalized_username_unique').on(
      table.guildId,
      table.normalizedUsername,
    ),
    unique('tracked_accounts_id_guild_unique').on(table.id, table.guildId),
    index('tracked_accounts_guild_quota_owner_index').on(
      table.guildId,
      table.quotaOwnerDiscordUserId,
    ),
    uniqueIndex('tracked_accounts_guild_linked_default_unique')
      .on(table.guildId, table.linkedDiscordUserId)
      .where(sql`${table.isDefault}`),
    check(
      'tracked_accounts_association_check',
      sql`(
        (${table.associationType} = 'linked' AND ${table.linkedDiscordUserId} IS NOT NULL)
        OR (${table.associationType} = 'watchlist' AND ${table.linkedDiscordUserId} IS NULL)
      )`,
    ),
    check(
      'tracked_accounts_default_check',
      sql`(NOT ${table.isDefault} OR ${table.associationType} = 'linked')`,
    ),
  ],
);
