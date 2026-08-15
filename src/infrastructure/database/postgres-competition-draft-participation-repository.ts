import { and, eq, inArray, sql } from 'drizzle-orm';

import type {
  CompetitionDraftParticipationRepository,
  CompetitionEntrant,
  CompetitionEntrantInput,
  CompetitionParticipationResult,
} from '../../features/competitions/manage-draft-participation.js';
import type { Database, Transaction } from './connection.js';
import {
  competitionContributingAccounts,
  competitionEntrants,
  competitionRoles,
  competitions,
  trackedAccounts,
} from './schema/index.js';

export class PostgresCompetitionDraftParticipationRepository implements CompetitionDraftParticipationRepository {
  public constructor(private readonly database: Database) {}

  public async listDrafts(
    guildId: string,
  ): Promise<readonly { id: string; displayName: string }[]> {
    return this.database
      .select({ displayName: competitions.displayName, id: competitions.id })
      .from(competitions)
      .where(and(eq(competitions.guildId, guildId), eq(competitions.state, 'draft')))
      .orderBy(competitions.createdAt, competitions.id);
  }

  public async listEntrants(
    guildId: string,
    competitionId: string,
  ): Promise<readonly CompetitionEntrant[]> {
    return this.database.transaction(async (transaction) => {
      const stored = await transaction
        .select()
        .from(competitionEntrants)
        .where(
          and(
            eq(competitionEntrants.guildId, guildId),
            eq(competitionEntrants.competitionId, competitionId),
          ),
        )
        .orderBy(competitionEntrants.createdAt, competitionEntrants.id);
      return Promise.all(stored.map((entrant) => this.toEntrant(transaction, entrant)));
    });
  }

  public join(request: {
    competitionId: string;
    contributingAccountIds: readonly string[];
    entrantId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionParticipationResult> {
    return this.database.transaction(async (transaction) => {
      const competition = await this.lockDraftCompetition(
        transaction,
        request.guildId,
        request.competitionId,
      );
      if (competition.kind !== 'draft') {
        return competition;
      }
      return this.insertEntrant(transaction, {
        competitionId: request.competitionId,
        contributingAccountIds: request.contributingAccountIds,
        entrant: { type: 'discord_member', discordUserId: request.requesterDiscordUserId },
        entrantId: request.entrantId,
        guildId: request.guildId,
        resultKind: 'joined',
      });
    });
  }

  public add(request: {
    canManageCompetitions: boolean;
    competitionId: string;
    entrant: CompetitionEntrantInput;
    entrantId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionParticipationResult> {
    return this.database.transaction(async (transaction) => {
      const competition = await this.lockDraftCompetition(
        transaction,
        request.guildId,
        request.competitionId,
      );
      if (competition.kind !== 'draft') {
        return competition;
      }
      if (
        !request.canManageCompetitions &&
        competition.createdByDiscordUserId !== request.requesterDiscordUserId
      ) {
        return { kind: 'forbidden' };
      }
      const entrant =
        request.entrant.type === 'discord_member'
          ? { type: 'discord_member' as const, discordUserId: request.entrant.discordUserId }
          : { type: 'watchlist' as const, watchlistAccountId: request.entrant.watchlistAccountId };
      return this.insertEntrant(transaction, {
        competitionId: request.competitionId,
        contributingAccountIds:
          request.entrant.type === 'discord_member'
            ? request.entrant.contributingAccountIds
            : [request.entrant.watchlistAccountId],
        entrant,
        entrantId: request.entrantId,
        guildId: request.guildId,
        resultKind: 'added',
      });
    });
  }

  public leave(request: {
    competitionId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionParticipationResult> {
    return this.database.transaction(async (transaction) => {
      const competition = await this.lockDraftCompetition(
        transaction,
        request.guildId,
        request.competitionId,
      );
      if (competition.kind !== 'draft') {
        return competition;
      }
      const [stored] = await transaction
        .select()
        .from(competitionEntrants)
        .where(
          and(
            eq(competitionEntrants.guildId, request.guildId),
            eq(competitionEntrants.competitionId, request.competitionId),
            eq(competitionEntrants.entrantType, 'discord_member'),
            eq(competitionEntrants.discordUserId, request.requesterDiscordUserId),
          ),
        );
      if (stored === undefined) {
        return { kind: 'entrant_not_found' };
      }
      const entrant = await this.toEntrant(transaction, stored);
      await transaction
        .delete(competitionEntrants)
        .where(
          and(
            eq(competitionEntrants.guildId, request.guildId),
            eq(competitionEntrants.id, stored.id),
          ),
        );
      await this.queueDraftRoleSync(transaction, request.guildId, request.competitionId);
      return { kind: 'left', entrant };
    });
  }

  public remove(request: {
    canManageCompetitions: boolean;
    competitionId: string;
    entrantId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionParticipationResult> {
    return this.database.transaction(async (transaction) => {
      const competition = await this.lockDraftCompetition(
        transaction,
        request.guildId,
        request.competitionId,
      );
      if (competition.kind !== 'draft') {
        return competition;
      }
      if (
        !request.canManageCompetitions &&
        competition.createdByDiscordUserId !== request.requesterDiscordUserId
      ) {
        return { kind: 'forbidden' };
      }
      const [stored] = await transaction
        .select()
        .from(competitionEntrants)
        .where(
          and(
            eq(competitionEntrants.guildId, request.guildId),
            eq(competitionEntrants.competitionId, request.competitionId),
            eq(competitionEntrants.id, request.entrantId),
          ),
        );
      if (stored === undefined) {
        return { kind: 'entrant_not_found' };
      }
      const entrant = await this.toEntrant(transaction, stored);
      await transaction
        .delete(competitionEntrants)
        .where(
          and(
            eq(competitionEntrants.guildId, request.guildId),
            eq(competitionEntrants.id, stored.id),
          ),
        );
      await this.queueDraftRoleSync(transaction, request.guildId, request.competitionId);
      return { kind: 'removed', entrant };
    });
  }

  private async lockDraftCompetition(
    transaction: Transaction,
    guildId: string,
    competitionId: string,
  ) {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
    const [competition] = await transaction
      .select({
        createdByDiscordUserId: competitions.createdByDiscordUserId,
        state: competitions.state,
      })
      .from(competitions)
      .where(and(eq(competitions.guildId, guildId), eq(competitions.id, competitionId)));
    if (competition === undefined) {
      return { kind: 'competition_not_found' as const };
    }
    return competition.state === 'draft'
      ? { kind: 'draft' as const, createdByDiscordUserId: competition.createdByDiscordUserId }
      : { kind: 'membership_locked' as const };
  }

  private async insertEntrant(
    transaction: Transaction,
    request: {
      competitionId: string;
      contributingAccountIds: readonly string[];
      entrant:
        | { type: 'discord_member'; discordUserId: string }
        | { type: 'watchlist'; watchlistAccountId: string };
      entrantId: string;
      guildId: string;
      resultKind: 'joined' | 'added';
    },
  ): Promise<CompetitionParticipationResult> {
    const accounts = await transaction
      .select({
        associationType: trackedAccounts.associationType,
        id: trackedAccounts.id,
        linkedDiscordUserId: trackedAccounts.linkedDiscordUserId,
      })
      .from(trackedAccounts)
      .where(
        and(
          eq(trackedAccounts.guildId, request.guildId),
          inArray(trackedAccounts.id, [...request.contributingAccountIds]),
        ),
      );
    if (!areValidContributingAccounts(request.entrant, request.contributingAccountIds, accounts)) {
      return { kind: 'invalid_accounts' };
    }

    const [existingEntrant] = await transaction
      .select({ id: competitionEntrants.id })
      .from(competitionEntrants)
      .where(
        request.entrant.type === 'discord_member'
          ? and(
              eq(competitionEntrants.competitionId, request.competitionId),
              eq(competitionEntrants.discordUserId, request.entrant.discordUserId),
            )
          : and(
              eq(competitionEntrants.competitionId, request.competitionId),
              eq(competitionEntrants.watchlistAccountId, request.entrant.watchlistAccountId),
            ),
      );
    if (existingEntrant !== undefined) {
      return { kind: 'already_joined' };
    }

    const [selectedAccount] = await transaction
      .select({ trackedAccountId: competitionContributingAccounts.trackedAccountId })
      .from(competitionContributingAccounts)
      .where(
        and(
          eq(competitionContributingAccounts.competitionId, request.competitionId),
          inArray(competitionContributingAccounts.trackedAccountId, [
            ...request.contributingAccountIds,
          ]),
        ),
      )
      .limit(1);
    if (selectedAccount !== undefined) {
      return { kind: 'account_already_selected' };
    }

    await transaction.insert(competitionEntrants).values({
      competitionId: request.competitionId,
      discordUserId:
        request.entrant.type === 'discord_member' ? request.entrant.discordUserId : null,
      entrantType: request.entrant.type,
      guildId: request.guildId,
      id: request.entrantId,
      watchlistAccountId:
        request.entrant.type === 'watchlist' ? request.entrant.watchlistAccountId : null,
    });
    await transaction.insert(competitionContributingAccounts).values(
      request.contributingAccountIds.map((trackedAccountId) => ({
        competitionEntrantId: request.entrantId,
        competitionId: request.competitionId,
        guildId: request.guildId,
        trackedAccountId,
      })),
    );
    await this.queueDraftRoleSync(transaction, request.guildId, request.competitionId);
    return {
      kind: request.resultKind,
      entrant:
        request.entrant.type === 'discord_member'
          ? {
              competitionId: request.competitionId,
              contributingAccountIds: request.contributingAccountIds,
              discordUserId: request.entrant.discordUserId,
              guildId: request.guildId,
              id: request.entrantId,
              type: 'discord_member',
            }
          : {
              competitionId: request.competitionId,
              contributingAccountIds: [request.entrant.watchlistAccountId],
              guildId: request.guildId,
              id: request.entrantId,
              type: 'watchlist',
              watchlistAccountId: request.entrant.watchlistAccountId,
            },
    };
  }

  private async queueDraftRoleSync(
    transaction: Transaction,
    guildId: string,
    competitionId: string,
  ): Promise<void> {
    await transaction
      .update(competitionRoles)
      .set({ nextAttemptAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(competitionRoles.guildId, guildId),
          eq(competitionRoles.competitionId, competitionId),
          eq(competitionRoles.status, 'active'),
        ),
      );
  }

  private async toEntrant(
    transaction: Transaction,
    stored: typeof competitionEntrants.$inferSelect,
  ): Promise<CompetitionEntrant> {
    const accounts = await transaction
      .select({ trackedAccountId: competitionContributingAccounts.trackedAccountId })
      .from(competitionContributingAccounts)
      .where(
        and(
          eq(competitionContributingAccounts.guildId, stored.guildId),
          eq(competitionContributingAccounts.competitionEntrantId, stored.id),
        ),
      );
    const contributingAccountIds = accounts.map((account) => account.trackedAccountId);
    if (stored.entrantType === 'discord_member') {
      if (stored.discordUserId === null) {
        throw new Error('Discord entrant is missing its Discord user ID.');
      }
      return {
        ...stored,
        contributingAccountIds,
        discordUserId: stored.discordUserId,
        type: 'discord_member',
      };
    }
    if (stored.watchlistAccountId === null || contributingAccountIds.length !== 1) {
      throw new Error('Watchlist entrant has invalid contributing accounts.');
    }
    const [contributingAccountId] = contributingAccountIds;
    if (contributingAccountId === undefined) {
      throw new Error('Watchlist entrant is missing its contributing account.');
    }
    return {
      competitionId: stored.competitionId,
      contributingAccountIds: [contributingAccountId],
      guildId: stored.guildId,
      id: stored.id,
      type: 'watchlist',
      watchlistAccountId: stored.watchlistAccountId,
    };
  }
}

function areValidContributingAccounts(
  entrant:
    | { type: 'discord_member'; discordUserId: string }
    | { type: 'watchlist'; watchlistAccountId: string },
  accountIds: readonly string[],
  accounts: readonly {
    associationType: 'linked' | 'watchlist';
    id: string;
    linkedDiscordUserId: string | null;
  }[],
): boolean {
  if (accounts.length !== accountIds.length) {
    return false;
  }
  return entrant.type === 'discord_member'
    ? accounts.every(
        (account) =>
          account.associationType === 'linked' &&
          account.linkedDiscordUserId === entrant.discordUserId,
      )
    : accountIds.length === 1 &&
        accountIds[0] === entrant.watchlistAccountId &&
        accounts[0]?.associationType === 'watchlist';
}
