import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { guilds } from './guilds.js';

export const competitionTypes = [
  'most_skill_xp',
  'skill_xp_target_race',
  'most_boss_kc',
  'boss_kc_target_race',
] as const;
export const competitionStates = [
  'draft',
  'start_pending',
  'active',
  'finish_pending',
  'finished',
  'cancelled',
] as const;
export const competitionMetricKinds = ['skill', 'boss'] as const;

export const competitionType = pgEnum('competition_type', competitionTypes);
export const competitionState = pgEnum('competition_state', competitionStates);
export const competitionMetricKind = pgEnum('competition_metric_kind', competitionMetricKinds);

export const competitions = pgTable(
  'competitions',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.guildId, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    type: competitionType('type').notNull(),
    metricKind: competitionMetricKind('metric_kind').notNull(),
    metricName: text('metric_name').notNull(),
    targetValue: bigint('target_value', { mode: 'bigint' }),
    durationSeconds: integer('duration_seconds'),
    timezone: text('timezone').notNull(),
    state: competitionState('state').notNull().default('draft'),
    createdByDiscordUserId: text('created_by_discord_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('competitions_guild_normalized_name_unique').on(table.guildId, table.normalizedName),
    check(
      'competitions_definition_check',
      sql`(
        (${table.type} IN ('most_skill_xp', 'most_boss_kc') AND ${table.durationSeconds} > 0 AND ${table.targetValue} IS NULL)
        OR
        (${table.type} IN ('skill_xp_target_race', 'boss_kc_target_race') AND ${table.targetValue} > 0 AND ${table.durationSeconds} IS NULL)
      )`,
    ),
    check(
      'competitions_metric_type_check',
      sql`(
        (${table.type} IN ('most_skill_xp', 'skill_xp_target_race') AND ${table.metricKind} = 'skill')
        OR
        (${table.type} IN ('most_boss_kc', 'boss_kc_target_race') AND ${table.metricKind} = 'boss')
      )`,
    ),
  ],
);
