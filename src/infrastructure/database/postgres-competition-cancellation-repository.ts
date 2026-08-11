import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type {
  CompetitionCancellationRepository,
  CompetitionCancellationResult,
} from '../../features/competitions/cancel-competition.js';
import type { Database, Transaction } from './connection.js';
import { competitions } from './schema/index.js';

export class PostgresCompetitionCancellationRepository implements CompetitionCancellationRepository {
  public constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public listCancellable(guildId: string): Promise<readonly { id: string; displayName: string }[]> {
    return this.database
      .select({ id: competitions.id, displayName: competitions.displayName })
      .from(competitions)
      .where(
        and(
          eq(competitions.guildId, guildId),
          inArray(competitions.state, ['draft', 'start_pending', 'active', 'finish_pending']),
        ),
      )
      .orderBy(asc(competitions.createdAt), asc(competitions.id));
  }

  public cancel(request: {
    canManageCompetitions: boolean;
    competitionId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionCancellationResult> {
    return this.database.transaction(async (transaction) => {
      await lockGuild(transaction, request.guildId);
      const [competition] = await transaction
        .select()
        .from(competitions)
        .where(
          and(
            eq(competitions.id, request.competitionId),
            eq(competitions.guildId, request.guildId),
          ),
        );
      if (competition === undefined) return { kind: 'competition_not_found' };
      if (
        !request.canManageCompetitions &&
        competition.createdByDiscordUserId !== request.requesterDiscordUserId
      )
        return { kind: 'forbidden' };
      if (!['draft', 'start_pending', 'active', 'finish_pending'].includes(competition.state))
        return { kind: 'cancellation_locked' };
      const [cancelled] = await transaction
        .update(competitions)
        .set({
          lastFinishFailureSummary: null,
          lastStartFailureSummary: null,
          nextFinishAttemptAt: null,
          nextStartAttemptAt: null,
          state: 'cancelled',
          updatedAt: this.now(),
        })
        .where(
          and(
            eq(competitions.id, request.competitionId),
            eq(competitions.guildId, request.guildId),
            inArray(competitions.state, ['draft', 'start_pending', 'active', 'finish_pending']),
          ),
        )
        .returning({ id: competitions.id });
      if (cancelled === undefined) return { kind: 'cancellation_locked' };
      return {
        kind: 'cancelled',
        competitionId: competition.id,
        displayName: competition.displayName,
        guildId: competition.guildId,
      };
    });
  }
}

async function lockGuild(transaction: Transaction, guildId: string): Promise<void> {
  await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
}
