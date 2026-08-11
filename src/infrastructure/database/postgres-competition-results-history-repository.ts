import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import type {
  CompetitionResultsHistoryRepository,
  FinishedCompetitionRecord,
} from '../../features/competitions/competition-results-history.js';
import type { Database } from './connection.js';
import {
  competitionAccountFinalValues,
  competitionAccountSnapshots,
  competitionEntrants,
  competitionTargetClaims,
  competitionWinners,
  competitions,
} from './schema/index.js';

export class PostgresCompetitionResultsHistoryRepository implements CompetitionResultsHistoryRepository {
  public constructor(private readonly database: Database) {}

  public async findFinished(request: { competitionId: string; guildId: string }) {
    const [competition] = await this.database
      .select()
      .from(competitions)
      .where(
        and(eq(competitions.id, request.competitionId), eq(competitions.guildId, request.guildId)),
      );
    if (competition === undefined) return { kind: 'competition_not_found' as const };
    if (competition.state === 'cancelled')
      return {
        kind: 'cancelled' as const,
        displayName: competition.displayName,
        cancelledAt: competition.updatedAt,
      };
    if (competition.state !== 'finished') return { kind: 'not_finished' as const };

    const accounts = await this.database
      .select({
        accountMode: competitionAccountSnapshots.accountMode,
        displayUsername: competitionAccountSnapshots.displayUsername,
        entrantDiscordUserId: competitionEntrants.discordUserId,
        entrantId: competitionAccountSnapshots.competitionEntrantId,
        finalValue: competitionAccountFinalValues.finalValue,
        id: competitionAccountSnapshots.trackedAccountId,
        startingValue: competitionAccountSnapshots.startingValue,
      })
      .from(competitionAccountSnapshots)
      .innerJoin(
        competitionEntrants,
        and(
          eq(competitionEntrants.id, competitionAccountSnapshots.competitionEntrantId),
          eq(competitionEntrants.competitionId, competitionAccountSnapshots.competitionId),
          eq(competitionEntrants.guildId, competitionAccountSnapshots.guildId),
        ),
      )
      .leftJoin(
        competitionAccountFinalValues,
        and(
          eq(
            competitionAccountFinalValues.competitionId,
            competitionAccountSnapshots.competitionId,
          ),
          eq(
            competitionAccountFinalValues.trackedAccountId,
            competitionAccountSnapshots.trackedAccountId,
          ),
          eq(competitionAccountFinalValues.guildId, competitionAccountSnapshots.guildId),
        ),
      )
      .where(
        and(
          eq(competitionAccountSnapshots.competitionId, request.competitionId),
          eq(competitionAccountSnapshots.guildId, request.guildId),
        ),
      )
      .orderBy(
        asc(competitionAccountSnapshots.competitionEntrantId),
        asc(competitionAccountSnapshots.trackedAccountId),
      );
    const winners = await this.database
      .select({
        entrantId: competitionWinners.competitionEntrantId,
        finalGain: competitionWinners.finalGain,
      })
      .from(competitionWinners)
      .where(
        and(
          eq(competitionWinners.competitionId, request.competitionId),
          eq(competitionWinners.guildId, request.guildId),
        ),
      )
      .orderBy(asc(competitionWinners.competitionEntrantId));
    if (winners.length === 0 && competition.winningTargetClaimId !== null) {
      const [claim] = await this.database
        .select({
          entrantId: competitionTargetClaims.entrantId,
          finalGain: competitionTargetClaims.finalValue,
        })
        .from(competitionTargetClaims)
        .where(
          and(
            eq(competitionTargetClaims.id, competition.winningTargetClaimId),
            eq(competitionTargetClaims.guildId, request.guildId),
            eq(competitionTargetClaims.competitionId, request.competitionId),
            eq(competitionTargetClaims.status, 'verified'),
          ),
        );
      if (claim !== undefined && claim.finalGain !== null) {
        winners.push({ entrantId: claim.entrantId, finalGain: claim.finalGain });
      }
    }
    return {
      accounts: accounts.map((account) => ({
        accountMode: account.accountMode,
        displayUsername: account.displayUsername,
        discordUserId: account.entrantDiscordUserId,
        entrantId: account.entrantId,
        finalValue: account.finalValue,
        id: account.id,
        startingValue: account.startingValue,
      })),
      competitionId: competition.id,
      displayName: competition.displayName,
      finishedAt: competition.finishedAt,
      guildId: competition.guildId,
      isResultDelayed: competition.isResultDelayed,
      metric: { kind: competition.metricKind, name: competition.metricName },
      targetValue: competition.targetValue,
      winners,
    } satisfies FinishedCompetitionRecord;
  }

  public async listFinished(
    guildId: string,
  ): Promise<readonly { displayName: string; id: string; state: 'finished' | 'cancelled' }[]> {
    return this.database
      .select({
        displayName: competitions.displayName,
        id: competitions.id,
        state: competitions.state,
      })
      .from(competitions)
      .where(
        and(
          eq(competitions.guildId, guildId),
          inArray(competitions.state, ['finished', 'cancelled']),
        ),
      )
      .orderBy(desc(competitions.updatedAt), asc(competitions.id))
      .then((rows) =>
        rows.map((row) => ({ ...row, state: row.state as 'finished' | 'cancelled' })),
      );
  }
}
