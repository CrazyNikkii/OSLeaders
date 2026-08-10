import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import type {
  TargetRaceClaimAccount,
  TargetRaceClaimBeginResult,
  TargetRaceClaimFinalizeResult,
  TargetRaceClaimReady,
  TargetRaceClaimRepository,
} from '../../features/competitions/claim-target-race.js';
import type { Database, Transaction } from './connection.js';
import {
  competitionAccountSnapshots,
  competitionEntrants,
  competitionTargetClaims,
  competitions,
  guildMemberPresences,
} from './schema/index.js';

export class PostgresTargetRaceClaimRepository implements TargetRaceClaimRepository {
  public constructor(private readonly database: Database) {}

  public async listClaimableEntrants(request: {
    canManageCompetitions: boolean;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<readonly { competitionId: string; displayName: string; entrantId: string }[]> {
    const eligibility = request.canManageCompetitions
      ? or(
          eq(competitionEntrants.discordUserId, request.requesterDiscordUserId),
          eq(guildMemberPresences.isPresent, false),
        )
      : eq(competitionEntrants.discordUserId, request.requesterDiscordUserId);
    return this.database
      .select({
        competitionId: competitions.id,
        displayName: competitions.displayName,
        entrantId: competitionEntrants.id,
      })
      .from(competitions)
      .innerJoin(
        competitionEntrants,
        and(
          eq(competitionEntrants.guildId, competitions.guildId),
          eq(competitionEntrants.competitionId, competitions.id),
        ),
      )
      .leftJoin(
        guildMemberPresences,
        and(
          eq(guildMemberPresences.guildId, competitionEntrants.guildId),
          eq(guildMemberPresences.discordUserId, competitionEntrants.discordUserId),
        ),
      )
      .where(
        and(
          eq(competitions.guildId, request.guildId),
          eq(competitions.state, 'active'),
          isNull(competitions.winningTargetClaimId),
          or(
            eq(competitions.type, 'skill_xp_target_race'),
            eq(competitions.type, 'boss_kc_target_race'),
          ),
          eligibility,
        ),
      )
      .orderBy(asc(competitions.startedAt), asc(competitions.id), asc(competitionEntrants.id));
  }

  public async beginClaim(request: {
    canManageCompetitions: boolean;
    claimId: string;
    competitionId: string;
    entrantId: string;
    guildId: string;
    receivedAt: Date;
    requesterDiscordUserId: string;
  }): Promise<TargetRaceClaimBeginResult> {
    return this.database.transaction(async (transaction) => {
      await lockGuild(transaction, request.guildId);
      const prepared = await this.prepareEntrant(
        transaction,
        request.guildId,
        request.competitionId,
        request.entrantId,
        request.requesterDiscordUserId,
        request.canManageCompetitions,
        request.receivedAt,
      );
      if ('kind' in prepared) return prepared;
      await transaction.insert(competitionTargetClaims).values({
        competitionId: request.competitionId,
        entrantId: request.entrantId,
        guildId: request.guildId,
        id: request.claimId,
        receivedAt: request.receivedAt,
      });
      return {
        kind: 'ready',
        claim: { ...prepared, claimId: request.claimId, receivedAt: request.receivedAt },
      };
    });
  }

  public async prepareRetry(request: {
    canManageCompetitions: boolean;
    claimId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<TargetRaceClaimBeginResult> {
    return this.database.transaction(async (transaction) => {
      await lockGuild(transaction, request.guildId);
      const [claim] = await transaction
        .select()
        .from(competitionTargetClaims)
        .where(
          and(
            eq(competitionTargetClaims.guildId, request.guildId),
            eq(competitionTargetClaims.id, request.claimId),
          ),
        );
      if (claim === undefined) return { kind: 'claim_not_found' };
      if (claim.status !== 'pending') return { kind: 'claim_not_retryable' };
      const prepared = await this.prepareEntrant(
        transaction,
        request.guildId,
        claim.competitionId,
        claim.entrantId,
        request.requesterDiscordUserId,
        request.canManageCompetitions,
        claim.receivedAt,
      );
      if ('kind' in prepared) return prepared;
      return {
        kind: 'ready',
        claim: { ...prepared, claimId: claim.id, receivedAt: claim.receivedAt },
      };
    });
  }

  public async claimDueRetry(): Promise<TargetRaceClaimReady | undefined> {
    return this.database.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select({ guildId: competitionTargetClaims.guildId, id: competitionTargetClaims.id })
        .from(competitionTargetClaims)
        .innerJoin(
          competitions,
          and(
            eq(competitions.id, competitionTargetClaims.competitionId),
            eq(competitions.guildId, competitionTargetClaims.guildId),
          ),
        )
        .where(
          and(
            eq(competitionTargetClaims.status, 'pending'),
            eq(competitions.state, 'active'),
            isNull(competitions.winningTargetClaimId),
          ),
        )
        .orderBy(asc(competitionTargetClaims.receivedAt), asc(competitionTargetClaims.id))
        .limit(1);
      if (candidate === undefined) return undefined;
      await lockGuild(transaction, candidate.guildId);
      const [claim] = await transaction
        .select()
        .from(competitionTargetClaims)
        .where(
          and(
            eq(competitionTargetClaims.guildId, candidate.guildId),
            eq(competitionTargetClaims.id, candidate.id),
            eq(competitionTargetClaims.status, 'pending'),
          ),
        );
      if (claim === undefined) return undefined;
      const prepared = await this.prepareEntrantForDueRetry(
        transaction,
        claim.guildId,
        claim.competitionId,
        claim.entrantId,
        claim.receivedAt,
      );
      return 'kind' in prepared
        ? undefined
        : { ...prepared, claimId: claim.id, receivedAt: claim.receivedAt };
    });
  }

  public async recordTemporaryFailure(request: {
    claimId: string;
    failureSummary: string;
    guildId: string;
  }): Promise<void> {
    await this.database
      .update(competitionTargetClaims)
      .set({
        lastFailureSummary: request.failureSummary.slice(0, 500),
        verificationAttemptCount: sql`${competitionTargetClaims.verificationAttemptCount} + 1`,
      })
      .where(
        and(
          eq(competitionTargetClaims.guildId, request.guildId),
          eq(competitionTargetClaims.id, request.claimId),
          eq(competitionTargetClaims.status, 'pending'),
        ),
      );
  }

  public async recordVerificationFailure(request: {
    claimId: string;
    failureSummary: string;
    guildId: string;
  }): Promise<void> {
    await this.database
      .update(competitionTargetClaims)
      .set({
        lastFailureSummary: request.failureSummary.slice(0, 500),
        status: 'verification_failed',
      })
      .where(
        and(
          eq(competitionTargetClaims.guildId, request.guildId),
          eq(competitionTargetClaims.id, request.claimId),
          eq(competitionTargetClaims.status, 'pending'),
        ),
      );
  }

  public async finalize(request: {
    claimId: string;
    finalValue: bigint;
    guildId: string;
    verifiedAt: Date;
  }): Promise<TargetRaceClaimFinalizeResult> {
    return this.database.transaction(async (transaction) => {
      const [claim] = await transaction
        .select()
        .from(competitionTargetClaims)
        .where(
          and(
            eq(competitionTargetClaims.guildId, request.guildId),
            eq(competitionTargetClaims.id, request.claimId),
          ),
        );
      if (claim?.status !== 'pending') return { kind: 'claim_not_active' };
      await lockGuild(transaction, request.guildId);
      const [competition] = await transaction
        .select({
          state: competitions.state,
          targetValue: competitions.targetValue,
          winningTargetClaimId: competitions.winningTargetClaimId,
        })
        .from(competitions)
        .where(
          and(eq(competitions.guildId, request.guildId), eq(competitions.id, claim.competitionId)),
        );
      if (
        competition?.state !== 'active' ||
        competition?.targetValue === null ||
        competition?.winningTargetClaimId !== null
      ) {
        return { kind: 'claim_not_active' };
      }
      if (request.finalValue < competition.targetValue) {
        await transaction
          .update(competitionTargetClaims)
          .set({
            finalValue: request.finalValue,
            lastFailureSummary: null,
            status: 'not_reached',
            verifiedAt: request.verifiedAt,
          })
          .where(
            and(
              eq(competitionTargetClaims.guildId, request.guildId),
              eq(competitionTargetClaims.id, request.claimId),
              eq(competitionTargetClaims.status, 'pending'),
            ),
          );
        return {
          kind: 'target_not_reached',
          finalValue: request.finalValue,
          targetValue: competition.targetValue,
        };
      }
      const [earlierPending] = await transaction
        .select({ id: competitionTargetClaims.id })
        .from(competitionTargetClaims)
        .where(
          and(
            eq(competitionTargetClaims.guildId, request.guildId),
            eq(competitionTargetClaims.competitionId, claim.competitionId),
            eq(competitionTargetClaims.status, 'pending'),
            or(
              lt(competitionTargetClaims.receivedAt, claim.receivedAt),
              and(
                eq(competitionTargetClaims.receivedAt, claim.receivedAt),
                lt(competitionTargetClaims.id, claim.id),
              ),
            ),
          ),
        )
        .orderBy(asc(competitionTargetClaims.receivedAt), asc(competitionTargetClaims.id))
        .limit(1);
      if (earlierPending !== undefined) return { kind: 'earlier_claim_pending' };
      const [won] = await transaction
        .update(competitions)
        .set({
          state: 'finished',
          winningTargetClaimId: request.claimId,
          updatedAt: request.verifiedAt,
        })
        .where(
          and(
            eq(competitions.guildId, request.guildId),
            eq(competitions.id, claim.competitionId),
            eq(competitions.state, 'active'),
            isNull(competitions.winningTargetClaimId),
          ),
        )
        .returning({ id: competitions.id });
      if (won === undefined) return { kind: 'claim_not_active' };
      await transaction
        .update(competitionTargetClaims)
        .set({
          finalValue: request.finalValue,
          lastFailureSummary: null,
          status: 'verified',
          verifiedAt: request.verifiedAt,
        })
        .where(
          and(
            eq(competitionTargetClaims.guildId, request.guildId),
            eq(competitionTargetClaims.id, request.claimId),
          ),
        );
      return {
        kind: 'won',
        claimId: request.claimId,
        finalValue: request.finalValue,
        verifiedAt: request.verifiedAt,
      };
    });
  }

  private async prepareEntrant(
    transaction: Transaction,
    guildId: string,
    competitionId: string,
    entrantId: string,
    requesterDiscordUserId: string,
    canManageCompetitions: boolean,
    receivedAt: Date,
    bypassAuthorization = false,
  ): Promise<
    | Omit<TargetRaceClaimReady, 'claimId' | 'receivedAt'>
    | Exclude<TargetRaceClaimBeginResult, { kind: 'ready' }>
  > {
    const [competition] = await transaction
      .select({
        metricKind: competitions.metricKind,
        metricName: competitions.metricName,
        endsAt: competitions.endsAt,
        state: competitions.state,
        targetValue: competitions.targetValue,
        type: competitions.type,
      })
      .from(competitions)
      .where(and(eq(competitions.guildId, guildId), eq(competitions.id, competitionId)));
    if (competition === undefined) return { kind: 'competition_not_found' };
    if (competition.type !== 'skill_xp_target_race' && competition.type !== 'boss_kc_target_race')
      return { kind: 'not_target_race' };
    if (competition.state !== 'active') return { kind: 'not_active' };
    if (competition.endsAt !== null && receivedAt > competition.endsAt)
      return { kind: 'deadline_passed' };
    if (competition.targetValue === null)
      throw new Error('Target races must store a target value.');
    const [entrant] = await transaction
      .select({
        discordUserId: competitionEntrants.discordUserId,
        isPresent: guildMemberPresences.isPresent,
        id: competitionEntrants.id,
      })
      .from(competitionEntrants)
      .leftJoin(
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
          eq(competitionEntrants.id, entrantId),
        ),
      );
    if (entrant === undefined) return { kind: 'entrant_not_found' };
    const selfClaim = entrant.discordUserId === requesterDiscordUserId;
    const managerClaimForAbsentMember =
      canManageCompetitions && entrant.discordUserId !== null && entrant.isPresent === false;
    if (!bypassAuthorization && !selfClaim && !managerClaimForAbsentMember)
      return { kind: 'forbidden' };
    const accounts = await transaction
      .select({
        accountMode: competitionAccountSnapshots.accountMode,
        displayUsername: competitionAccountSnapshots.displayUsername,
        id: competitionAccountSnapshots.trackedAccountId,
        startingValue: competitionAccountSnapshots.startingValue,
      })
      .from(competitionAccountSnapshots)
      .where(
        and(
          eq(competitionAccountSnapshots.guildId, guildId),
          eq(competitionAccountSnapshots.competitionId, competitionId),
          eq(competitionAccountSnapshots.competitionEntrantId, entrantId),
        ),
      )
      .orderBy(competitionAccountSnapshots.trackedAccountId);
    if (accounts.length === 0) return { kind: 'entrant_not_found' };
    return {
      accounts: accounts satisfies readonly TargetRaceClaimAccount[],
      competitionId,
      entrantId,
      guildId,
      metric: { kind: competition.metricKind, name: competition.metricName },
      targetValue: competition.targetValue,
    };
  }

  private async prepareEntrantForDueRetry(
    transaction: Transaction,
    guildId: string,
    competitionId: string,
    entrantId: string,
    receivedAt: Date,
  ) {
    return this.prepareEntrant(
      transaction,
      guildId,
      competitionId,
      entrantId,
      '',
      true,
      receivedAt,
      true,
    );
  }
}

function lockGuild(transaction: Transaction, guildId: string): Promise<unknown> {
  return transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
}
