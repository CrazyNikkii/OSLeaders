import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import type {
  CompetitionRoleRepository,
  PendingCompetitionRoleOperation,
} from '../../features/competitions/manage-competition-role.js';
import type { Database, Transaction } from './connection.js';
import {
  competitionEntrants,
  competitionRoles,
  competitions,
  guildMemberPresences,
} from './schema/index.js';

const LEASE_MS = 5 * 60_000;

export class PostgresCompetitionRoleRepository implements CompetitionRoleRepository {
  public constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async claimDueOperation(): Promise<PendingCompetitionRoleOperation | undefined> {
    const now = this.now();
    const [candidate] = await this.database
      .select({ guildId: competitionRoles.guildId })
      .from(competitionRoles)
      .innerJoin(
        competitions,
        and(
          eq(competitions.id, competitionRoles.competitionId),
          eq(competitions.guildId, competitionRoles.guildId),
        ),
      )
      .where(actionableCondition(now))
      .orderBy(asc(competitionRoles.nextAttemptAt), asc(competitionRoles.createdAt))
      .limit(1);
    if (candidate === undefined) return undefined;
    return this.database.transaction(async (transaction) => {
      await lockGuild(transaction, candidate.guildId);
      return this.claimInTransaction(transaction, candidate.guildId, now);
    });
  }

  public async findActiveRoleId(request: {
    competitionId: string;
    guildId: string;
  }): Promise<string | undefined> {
    const [role] = await this.database
      .select({ discordRoleId: competitionRoles.discordRoleId })
      .from(competitionRoles)
      .where(
        and(
          eq(competitionRoles.competitionId, request.competitionId),
          eq(competitionRoles.guildId, request.guildId),
          eq(competitionRoles.status, 'active'),
        ),
      );
    return role?.discordRoleId ?? undefined;
  }

  public recordCreated(request: {
    competitionId: string;
    discordRoleId: string;
    guildId: string;
  }): Promise<void> {
    return this.finish(request.guildId, request.competitionId, 'creating', {
      discordRoleId: request.discordRoleId,
      nextAttemptAt: this.now(),
      status: 'active',
    });
  }

  public recordCleaned(request: { competitionId: string; guildId: string }): Promise<void> {
    return this.finish(request.guildId, request.competitionId, 'cleaning', {
      discordRoleId: null,
      nextAttemptAt: null,
      status: 'cleaned',
    });
  }

  public recordFailure(request: {
    competitionId: string;
    failureSummary: string;
    guildId: string;
    nextAttemptAt: Date;
    operation: 'create' | 'cleanup' | 'sync';
  }): Promise<void> {
    const status =
      request.operation === 'create'
        ? 'creating'
        : request.operation === 'cleanup'
          ? 'cleaning'
          : 'active';
    const retryStatus =
      request.operation === 'create'
        ? 'pending_create'
        : request.operation === 'cleanup'
          ? 'cleanup_pending'
          : 'active';
    return this.finish(request.guildId, request.competitionId, status, {
      lastFailureSummary: request.failureSummary.slice(0, 500),
      nextAttemptAt: request.nextAttemptAt,
      status: retryStatus,
    });
  }

  public recordSynced(request: {
    competitionId: string;
    guildId: string;
    leaseExpiresAt: Date;
    nextAttemptAt: Date;
  }): Promise<void> {
    return this.database.transaction(async (transaction) => {
      await lockGuild(transaction, request.guildId);
      await transaction
        .update(competitionRoles)
        .set({ nextAttemptAt: request.nextAttemptAt, updatedAt: this.now() })
        .where(
          and(
            eq(competitionRoles.guildId, request.guildId),
            eq(competitionRoles.competitionId, request.competitionId),
            eq(competitionRoles.status, 'active'),
            eq(competitionRoles.nextAttemptAt, request.leaseExpiresAt),
          ),
        );
    });
  }

  public recordMissingRole(request: { competitionId: string; guildId: string }): Promise<void> {
    return this.finish(request.guildId, request.competitionId, 'active', {
      discordRoleId: null,
      nextAttemptAt: this.now(),
      status: 'pending_create',
    });
  }

  private async claimInTransaction(
    transaction: Transaction,
    guildId: string,
    now: Date,
  ): Promise<PendingCompetitionRoleOperation | undefined> {
    const [role] = await transaction
      .select({
        attemptCount: competitionRoles.attemptCount,
        competitionId: competitionRoles.competitionId,
        creatorDiscordUserId: competitions.createdByDiscordUserId,
        discordRoleId: competitionRoles.discordRoleId,
        displayName: competitions.displayName,
        state: competitions.state,
        status: competitionRoles.status,
      })
      .from(competitionRoles)
      .innerJoin(
        competitions,
        and(
          eq(competitions.id, competitionRoles.competitionId),
          eq(competitions.guildId, competitionRoles.guildId),
        ),
      )
      .where(and(eq(competitionRoles.guildId, guildId), actionableCondition(now)))
      .orderBy(asc(competitionRoles.nextAttemptAt), asc(competitionRoles.createdAt))
      .limit(1);
    if (role === undefined) return undefined;
    const operation = operationFor(role.status, role.state, role.discordRoleId);
    if (operation === undefined) return undefined;
    const expected =
      operation === 'create'
        ? (['pending_create', 'creating'] as const)
        : operation === 'cleanup'
          ? (['pending_create', 'creating', 'active', 'cleanup_pending', 'cleaning'] as const)
          : (['active'] as const);
    const nextStatus =
      operation === 'create' ? 'creating' : operation === 'cleanup' ? 'cleaning' : 'active';
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    const [claimed] = await transaction
      .update(competitionRoles)
      .set({
        attemptCount: sql`${competitionRoles.attemptCount} + 1`,
        nextAttemptAt: leaseExpiresAt,
        status: nextStatus,
        updatedAt: now,
      })
      .where(
        and(
          eq(competitionRoles.guildId, guildId),
          eq(competitionRoles.competitionId, role.competitionId),
          inArray(competitionRoles.status, expected),
        ),
      )
      .returning({ competitionId: competitionRoles.competitionId });
    if (claimed === undefined) return undefined;
    const memberDiscordUserIds = await presentEntrantIds(transaction, guildId, role.competitionId);
    return {
      attemptCount: role.attemptCount + 1,
      competitionId: role.competitionId,
      creatorDiscordUserId: role.creatorDiscordUserId,
      displayName: role.displayName,
      discordRoleId: role.discordRoleId,
      guildId,
      leaseExpiresAt,
      memberDiscordUserIds,
      operation,
    };
  }

  private async finish(
    guildId: string,
    competitionId: string,
    expectedStatus: 'active' | 'cleaning' | 'creating',
    values: Partial<typeof competitionRoles.$inferInsert>,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await lockGuild(transaction, guildId);
      const [updated] = await transaction
        .update(competitionRoles)
        .set({ ...values, updatedAt: this.now() })
        .where(
          and(
            eq(competitionRoles.guildId, guildId),
            eq(competitionRoles.competitionId, competitionId),
            eq(competitionRoles.status, expectedStatus),
          ),
        )
        .returning({ competitionId: competitionRoles.competitionId });
      if (updated === undefined)
        throw new Error('Competition role operation is no longer in progress.');
    });
  }
}

function dueCondition(now: Date) {
  const stale = new Date(now.getTime() - LEASE_MS);
  return or(
    and(
      inArray(competitionRoles.status, ['pending_create', 'cleanup_pending']),
      or(isNull(competitionRoles.nextAttemptAt), lte(competitionRoles.nextAttemptAt, now)),
    ),
    and(
      inArray(competitionRoles.status, ['creating', 'cleaning']),
      lte(competitionRoles.updatedAt, stale),
    ),
    and(
      eq(competitionRoles.status, 'active'),
      or(isNull(competitionRoles.nextAttemptAt), lte(competitionRoles.nextAttemptAt, now)),
    ),
  );
}

function actionableCondition(now: Date) {
  return and(
    dueCondition(now),
    or(
      inArray(competitionRoles.status, [
        'pending_create',
        'creating',
        'cleanup_pending',
        'cleaning',
      ]),
      and(
        eq(competitionRoles.status, 'active'),
        inArray(competitions.state, ['draft', 'finished', 'cancelled']),
      ),
    ),
  );
}

function operationFor(
  status: 'pending_create' | 'creating' | 'active' | 'cleanup_pending' | 'cleaning' | 'cleaned',
  state: 'draft' | 'start_pending' | 'active' | 'finish_pending' | 'finished' | 'cancelled',
  discordRoleId: string | null,
): 'create' | 'cleanup' | 'sync' | undefined {
  if (state === 'finished' || state === 'cancelled')
    return status === 'cleaned' ? undefined : 'cleanup';
  if (status === 'pending_create' || status === 'creating') return 'create';
  return status === 'active' && discordRoleId !== null && state === 'draft' ? 'sync' : undefined;
}

async function presentEntrantIds(
  transaction: Transaction,
  guildId: string,
  competitionId: string,
): Promise<readonly string[]> {
  const entrants = await transaction
    .select({ discordUserId: competitionEntrants.discordUserId })
    .from(competitionEntrants)
    .innerJoin(
      guildMemberPresences,
      and(
        eq(guildMemberPresences.guildId, competitionEntrants.guildId),
        eq(guildMemberPresences.discordUserId, competitionEntrants.discordUserId),
      ),
    )
    .where(
      and(
        eq(competitionEntrants.guildId, guildId),
        eq(competitionEntrants.competitionId, competitionId),
        eq(competitionEntrants.entrantType, 'discord_member'),
        eq(guildMemberPresences.isPresent, true),
      ),
    );
  return entrants.flatMap((entrant) =>
    entrant.discordUserId === null ? [] : [entrant.discordUserId],
  );
}

async function lockGuild(transaction: Transaction, guildId: string): Promise<void> {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
}
