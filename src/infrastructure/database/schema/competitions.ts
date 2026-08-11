import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  integer,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { guilds } from './guilds.js';
import { osrsAccountMode, trackedAccounts } from './tracked-accounts.js';

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
export const competitionEntrantTypes = ['discord_member', 'watchlist'] as const;
export const competitionTargetClaimStatuses = [
  'pending',
  'not_reached',
  'verification_failed',
  'verified',
] as const;

export const competitionType = pgEnum('competition_type', competitionTypes);
export const competitionState = pgEnum('competition_state', competitionStates);
export const competitionMetricKind = pgEnum('competition_metric_kind', competitionMetricKinds);
export const competitionEntrantType = pgEnum('competition_entrant_type', competitionEntrantTypes);
export const competitionTargetClaimStatus = pgEnum(
  'competition_target_claim_status',
  competitionTargetClaimStatuses,
);
export const competitionResultDeliveryStatuses = [
  'pending',
  'delivering',
  'delivered',
  'failed',
] as const;
export const competitionResultDeliveryStatus = pgEnum(
  'competition_result_delivery_status',
  competitionResultDeliveryStatuses,
);
export const competitionRoleStatuses = [
  'pending_create',
  'creating',
  'active',
  'cleanup_pending',
  'cleaning',
  'cleaned',
] as const;
export const competitionRoleStatus = pgEnum('competition_role_status', competitionRoleStatuses);

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
    intendedStartAt: timestamp('intended_start_at', { withTimezone: true }),
    state: competitionState('state').notNull().default('draft'),
    startAttemptCount: integer('start_attempt_count').notNull().default(0),
    nextStartAttemptAt: timestamp('next_start_attempt_at', { withTimezone: true }),
    lastStartFailureSummary: text('last_start_failure_summary'),
    finishAttemptCount: integer('finish_attempt_count').notNull().default(0),
    nextFinishAttemptAt: timestamp('next_finish_attempt_at', { withTimezone: true }),
    lastFinishFailureSummary: text('last_finish_failure_summary'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    isResultDelayed: boolean('is_result_delayed').notNull().default(false),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    winningTargetClaimId: text('winning_target_claim_id'),
    createdByDiscordUserId: text('created_by_discord_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('competitions_guild_normalized_name_unique').on(table.guildId, table.normalizedName),
    unique('competitions_id_guild_unique').on(table.id, table.guildId),
    check(
      'competitions_definition_check',
      sql`(
        (${table.type} IN ('most_skill_xp', 'most_boss_kc') AND ${table.durationSeconds} > 0 AND ${table.targetValue} IS NULL)
        OR
        (${table.type} IN ('skill_xp_target_race', 'boss_kc_target_race') AND ${table.targetValue} > 0 AND (${table.durationSeconds} IS NULL OR ${table.durationSeconds} > 0))
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

export const competitionAccountSnapshots = pgTable(
  'competition_account_snapshots',
  {
    competitionId: text('competition_id').notNull(),
    guildId: text('guild_id').notNull(),
    trackedAccountId: text('tracked_account_id').notNull(),
    competitionEntrantId: text('competition_entrant_id').notNull(),
    displayUsername: text('display_username').notNull(),
    accountMode: osrsAccountMode('account_mode').notNull(),
    startingValue: bigint('starting_value', { mode: 'bigint' }).notNull(),
    startingObservedAt: timestamp('starting_observed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.competitionId, table.trackedAccountId] }),
    foreignKey({
      columns: [table.competitionId, table.guildId],
      foreignColumns: [competitions.id, competitions.guildId],
      name: 'competition_account_snapshots_competition_guild_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.competitionEntrantId, table.guildId, table.competitionId],
      foreignColumns: [
        competitionEntrants.id,
        competitionEntrants.guildId,
        competitionEntrants.competitionId,
      ],
      name: 'competition_account_snapshots_entrant_guild_competition_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.trackedAccountId, table.guildId],
      foreignColumns: [trackedAccounts.id, trackedAccounts.guildId],
      name: 'competition_account_snapshots_tracked_account_guild_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * The latest successfully observed value for an active competition account.
 * Starting snapshots remain immutable; this table lets standings survive a
 * partial Hiscores failure and a process restart.
 */
export const competitionAccountProgress = pgTable(
  'competition_account_progress',
  {
    competitionId: text('competition_id').notNull(),
    guildId: text('guild_id').notNull(),
    trackedAccountId: text('tracked_account_id').notNull(),
    lastKnownValue: bigint('last_known_value', { mode: 'bigint' }).notNull(),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.competitionId, table.trackedAccountId] }),
    foreignKey({
      columns: [table.competitionId, table.guildId],
      foreignColumns: [competitions.id, competitions.guildId],
      name: 'competition_account_progress_competition_guild_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.competitionId, table.trackedAccountId],
      foreignColumns: [
        competitionAccountSnapshots.competitionId,
        competitionAccountSnapshots.trackedAccountId,
      ],
      name: 'competition_account_progress_snapshot_fk',
    }).onDelete('cascade'),
  ],
);

/** Immutable final values retained when a competition is finalized. */
export const competitionAccountFinalValues = pgTable(
  'competition_account_final_values',
  {
    competitionId: text('competition_id').notNull(),
    guildId: text('guild_id').notNull(),
    trackedAccountId: text('tracked_account_id').notNull(),
    finalValue: bigint('final_value', { mode: 'bigint' }).notNull(),
    finalObservedAt: timestamp('final_observed_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.competitionId, table.trackedAccountId] }),
    foreignKey({
      columns: [table.competitionId, table.guildId],
      foreignColumns: [competitions.id, competitions.guildId],
      name: 'competition_account_final_values_competition_guild_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.competitionId, table.trackedAccountId],
      foreignColumns: [
        competitionAccountSnapshots.competitionId,
        competitionAccountSnapshots.trackedAccountId,
      ],
      name: 'competition_account_final_values_snapshot_fk',
    }).onDelete('restrict'),
  ],
);

/** One row per winner; multiple rows represent an exact shared tie. */
export const competitionWinners = pgTable(
  'competition_winners',
  {
    competitionId: text('competition_id').notNull(),
    guildId: text('guild_id').notNull(),
    competitionEntrantId: text('competition_entrant_id').notNull(),
    finalGain: bigint('final_gain', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.competitionId, table.competitionEntrantId] }),
    foreignKey({
      columns: [table.competitionId, table.guildId],
      foreignColumns: [competitions.id, competitions.guildId],
      name: 'competition_winners_competition_guild_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.competitionEntrantId, table.guildId, table.competitionId],
      foreignColumns: [
        competitionEntrants.id,
        competitionEntrants.guildId,
        competitionEntrants.competitionId,
      ],
      name: 'competition_winners_entrant_guild_competition_fk',
    }).onDelete('restrict'),
  ],
);

export const competitionEntrants = pgTable(
  'competition_entrants',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id').notNull(),
    competitionId: text('competition_id').notNull(),
    entrantType: competitionEntrantType('entrant_type').notNull(),
    discordUserId: text('discord_user_id'),
    watchlistAccountId: text('watchlist_account_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('competition_entrants_id_guild_competition_unique').on(
      table.id,
      table.guildId,
      table.competitionId,
    ),
    unique('competition_entrants_competition_discord_member_unique').on(
      table.competitionId,
      table.discordUserId,
    ),
    unique('competition_entrants_competition_watchlist_account_unique').on(
      table.competitionId,
      table.watchlistAccountId,
    ),
    foreignKey({
      columns: [table.competitionId, table.guildId],
      foreignColumns: [competitions.id, competitions.guildId],
      name: 'competition_entrants_competition_guild_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.watchlistAccountId, table.guildId],
      foreignColumns: [trackedAccounts.id, trackedAccounts.guildId],
      name: 'competition_entrants_watchlist_account_guild_fk',
    }).onDelete('restrict'),
    check(
      'competition_entrants_association_check',
      sql`(
        (${table.entrantType} = 'discord_member' AND ${table.discordUserId} IS NOT NULL AND ${table.watchlistAccountId} IS NULL)
        OR
        (${table.entrantType} = 'watchlist' AND ${table.discordUserId} IS NULL AND ${table.watchlistAccountId} IS NOT NULL)
      )`,
    ),
  ],
);

export const competitionContributingAccounts = pgTable(
  'competition_contributing_accounts',
  {
    competitionEntrantId: text('competition_entrant_id').notNull(),
    competitionId: text('competition_id').notNull(),
    guildId: text('guild_id').notNull(),
    trackedAccountId: text('tracked_account_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.competitionEntrantId, table.trackedAccountId] }),
    unique('competition_contributing_accounts_competition_account_unique').on(
      table.competitionId,
      table.trackedAccountId,
    ),
    foreignKey({
      columns: [table.competitionEntrantId, table.guildId, table.competitionId],
      foreignColumns: [
        competitionEntrants.id,
        competitionEntrants.guildId,
        competitionEntrants.competitionId,
      ],
      name: 'competition_contributing_accounts_entrant_guild_competition_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.competitionId, table.guildId],
      foreignColumns: [competitions.id, competitions.guildId],
      name: 'competition_contributing_accounts_competition_guild_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.trackedAccountId, table.guildId],
      foreignColumns: [trackedAccounts.id, trackedAccounts.guildId],
      name: 'competition_contributing_accounts_tracked_account_guild_fk',
    }).onDelete('restrict'),
  ],
);

export const competitionTargetClaims = pgTable(
  'competition_target_claims',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id').notNull(),
    competitionId: text('competition_id').notNull(),
    entrantId: text('competition_entrant_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    status: competitionTargetClaimStatus('status').notNull().default('pending'),
    verificationAttemptCount: integer('verification_attempt_count').notNull().default(0),
    lastFailureSummary: text('last_failure_summary'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    finalValue: bigint('final_value', { mode: 'bigint' }),
  },
  (table) => [
    unique('competition_target_claims_id_guild_competition_unique').on(
      table.id,
      table.guildId,
      table.competitionId,
    ),
    foreignKey({
      columns: [table.competitionId, table.guildId],
      foreignColumns: [competitions.id, competitions.guildId],
      name: 'competition_target_claims_competition_guild_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.entrantId, table.guildId, table.competitionId],
      foreignColumns: [
        competitionEntrants.id,
        competitionEntrants.guildId,
        competitionEntrants.competitionId,
      ],
      name: 'competition_target_claims_entrant_guild_competition_fk',
    }).onDelete('restrict'),
  ],
);

/** Durable, at-least-once final-result posts. A record is created before Discord delivery. */
export const competitionResultDeliveries = pgTable(
  'competition_result_deliveries',
  {
    id: text('id').primaryKey(),
    guildId: text('guild_id')
      .notNull()
      .references(() => guilds.guildId, { onDelete: 'cascade' }),
    competitionId: text('competition_id').notNull(),
    channelId: text('channel_id').notNull(),
    status: competitionResultDeliveryStatus('status').notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastFailureSummary: text('last_failure_summary'),
    discordMessageId: text('discord_message_id'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('competition_result_deliveries_competition_guild_unique').on(
      table.competitionId,
      table.guildId,
    ),
    foreignKey({
      columns: [table.competitionId, table.guildId],
      foreignColumns: [competitions.id, competitions.guildId],
      name: 'competition_result_deliveries_competition_guild_fk',
    }).onDelete('cascade'),
    index('competition_result_deliveries_status_next_attempt_at_index').on(
      table.status,
      table.nextAttemptAt,
    ),
    check('competition_result_deliveries_attempt_count_check', sql`${table.attemptCount} >= 0`),
  ],
);

/** Durable state for an optional temporary Discord role owned by one competition. */
export const competitionRoles = pgTable(
  'competition_roles',
  {
    competitionId: text('competition_id').notNull(),
    guildId: text('guild_id').notNull(),
    discordRoleId: text('discord_role_id'),
    status: competitionRoleStatus('status').notNull().default('pending_create'),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastFailureSummary: text('last_failure_summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.competitionId, table.guildId] }),
    foreignKey({
      columns: [table.competitionId, table.guildId],
      foreignColumns: [competitions.id, competitions.guildId],
      name: 'competition_roles_competition_guild_fk',
    }).onDelete('cascade'),
    index('competition_roles_status_next_attempt_at_index').on(table.status, table.nextAttemptAt),
    check('competition_roles_attempt_count_check', sql`${table.attemptCount} >= 0`),
  ],
);
