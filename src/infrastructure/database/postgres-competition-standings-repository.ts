import { and, asc, eq, sql } from 'drizzle-orm';

import type {
  ActiveCompetitionForStandings,
  CompetitionStandingsRepository,
} from '../../features/competitions/competition-standings.js';
import type { Database } from './connection.js';
import {
  competitionAccountProgress,
  competitionAccountSnapshots,
  competitionEntrants,
  competitions,
} from './schema/index.js';

export class PostgresCompetitionStandingsRepository implements CompetitionStandingsRepository {
  public constructor(private readonly database: Database) {}

  public async findActive(request: { competitionId: string; guildId: string }) {
    const [competition] = await this.database
      .select({
        endsAt: competitions.endsAt,
        metricKind: competitions.metricKind,
        metricName: competitions.metricName,
        state: competitions.state,
        targetValue: competitions.targetValue,
      })
      .from(competitions)
      .where(
        and(eq(competitions.id, request.competitionId), eq(competitions.guildId, request.guildId)),
      );
    if (competition === undefined) return { kind: 'competition_not_found' as const };
    if (competition.state !== 'active') return { kind: 'not_active' as const };
    const accounts = await this.database
      .select({
        accountMode: competitionAccountSnapshots.accountMode,
        displayUsername: competitionAccountSnapshots.displayUsername,
        entrantDiscordUserId: competitionEntrants.discordUserId,
        entrantId: competitionAccountSnapshots.competitionEntrantId,
        id: competitionAccountSnapshots.trackedAccountId,
        lastKnownValue: competitionAccountProgress.lastKnownValue,
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
        competitionAccountProgress,
        and(
          eq(competitionAccountProgress.competitionId, competitionAccountSnapshots.competitionId),
          eq(
            competitionAccountProgress.trackedAccountId,
            competitionAccountSnapshots.trackedAccountId,
          ),
        ),
      )
      .where(
        and(
          eq(competitionAccountSnapshots.competitionId, request.competitionId),
          eq(competitionAccountSnapshots.guildId, request.guildId),
        ),
      )
      .orderBy(
        competitionAccountSnapshots.competitionEntrantId,
        competitionAccountSnapshots.trackedAccountId,
      );
    return {
      accounts: accounts.map((account) => ({
        ...account,
        lastKnownValue: account.lastKnownValue ?? account.startingValue,
      })),
      competitionId: request.competitionId,
      endsAt: competition.endsAt,
      guildId: request.guildId,
      metric: { kind: competition.metricKind, name: competition.metricName },
      targetValue: competition.targetValue,
    } satisfies ActiveCompetitionForStandings;
  }

  public async listActive(
    guildId: string,
  ): Promise<readonly { displayName: string; id: string }[]> {
    return this.database
      .select({ displayName: competitions.displayName, id: competitions.id })
      .from(competitions)
      .where(and(eq(competitions.guildId, guildId), eq(competitions.state, 'active')))
      .orderBy(asc(competitions.startedAt), asc(competitions.id));
  }

  public async recordObservedValues(request: {
    competitionId: string;
    guildId: string;
    observedAt: Date;
    values: readonly { accountId: string; value: bigint }[];
  }): Promise<void> {
    if (request.values.length === 0) return;
    await this.database.transaction(async (transaction) => {
      const [active] = await transaction
        .select({ id: competitions.id })
        .from(competitions)
        .where(
          and(
            eq(competitions.id, request.competitionId),
            eq(competitions.guildId, request.guildId),
            eq(competitions.state, 'active'),
          ),
        );
      if (active === undefined) return;
      await transaction
        .insert(competitionAccountProgress)
        .values(
          request.values.map((value) => ({
            competitionId: request.competitionId,
            guildId: request.guildId,
            lastKnownValue: value.value,
            lastObservedAt: request.observedAt,
            trackedAccountId: value.accountId,
          })),
        )
        .onConflictDoUpdate({
          target: [
            competitionAccountProgress.competitionId,
            competitionAccountProgress.trackedAccountId,
          ],
          set: {
            lastKnownValue: sql`excluded.last_known_value`,
            lastObservedAt: sql`excluded.last_observed_at`,
          },
          setWhere: sql`${competitionAccountProgress.lastObservedAt} <= excluded.last_observed_at`,
        });
    });
  }
}
