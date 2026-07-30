import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { guilds } from './guilds.js';

export const dailyRecapRunTriggers = ['automatic', 'manual'] as const;
export const dailyRecapRunStatuses = [
  'pending_collection',
  'collecting',
  'delivery_pending',
  'delivered',
  'failed',
] as const;
export const dailyRecapDeliveryStatuses = ['pending', 'delivering', 'delivered', 'failed'] as const;

export const dailyRecapRunTrigger = pgEnum('daily_recap_run_trigger', dailyRecapRunTriggers);
export const dailyRecapRunStatus = pgEnum('daily_recap_run_status', dailyRecapRunStatuses);
export const dailyRecapDeliveryStatus = pgEnum(
  'daily_recap_delivery_status',
  dailyRecapDeliveryStatuses,
);

export const dailyRecapRuns = pgTable(
  'daily_recap_runs',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.guildId, { onDelete: 'cascade' }),
    trigger: dailyRecapRunTrigger('trigger').notNull(),
    status: dailyRecapRunStatus('status').notNull().default('pending_collection'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    collectionAttemptCount: integer('collection_attempt_count').notNull().default(0),
    nextCollectionAttemptAt: timestamp('next_collection_attempt_at', { withTimezone: true }),
    lastCollectionFailureSummary: text('last_collection_failure_summary'),
    collectionStartedAt: timestamp('collection_started_at', { withTimezone: true }),
    collectionCompletedAt: timestamp('collection_completed_at', { withTimezone: true }),
    comparisonStartedAt: timestamp('comparison_started_at', { withTimezone: true }),
    comparisonCompletedAt: timestamp('comparison_completed_at', { withTimezone: true }),
    accountOutcomes: jsonb('account_outcomes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('daily_recap_runs_id_guild_unique').on(table.id, table.guildId),
    uniqueIndex('daily_recap_runs_automatic_schedule_unique')
      .on(table.guildId, table.scheduledFor)
      .where(sql`${table.trigger} = 'automatic'`),
    index('daily_recap_runs_guild_status_scheduled_for_index').on(
      table.guildId,
      table.status,
      table.scheduledFor,
    ),
    index('daily_recap_runs_status_next_collection_attempt_at_index').on(
      table.status,
      table.nextCollectionAttemptAt,
    ),
    check(
      'daily_recap_runs_automatic_schedule_check',
      sql`(${table.trigger} <> 'automatic' OR ${table.scheduledFor} IS NOT NULL)`,
    ),
    check(
      'daily_recap_runs_collection_attempt_count_check',
      sql`${table.collectionAttemptCount} >= 0`,
    ),
  ],
);

export const dailyRecapDeliveries = pgTable(
  'daily_recap_deliveries',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.guildId, { onDelete: 'cascade' }),
    recapRunId: text('recap_run_id').notNull(),
    channelId: text('channel_id').notNull(),
    content: text('content').notNull(),
    status: dailyRecapDeliveryStatus('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastFailureSummary: text('last_failure_summary'),
    discordMessageId: text('discord_message_id'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.recapRunId, table.guildId],
      foreignColumns: [dailyRecapRuns.id, dailyRecapRuns.guildId],
      name: 'daily_recap_deliveries_run_guild_daily_recap_runs_fk',
    }).onDelete('cascade'),
    unique('daily_recap_deliveries_run_guild_unique').on(table.recapRunId, table.guildId),
    index('daily_recap_deliveries_status_next_attempt_at_index').on(
      table.status,
      table.nextAttemptAt,
    ),
    check('daily_recap_deliveries_attempt_count_check', sql`${table.attemptCount} >= 0`),
  ],
);
