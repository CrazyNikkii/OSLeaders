import { and, eq } from 'drizzle-orm';

import type { CompetitionSchedulingRepository } from '../../features/competitions/schedule-competition.js';
import type { Database } from './connection.js';
import { competitions } from './schema/index.js';

export class PostgresCompetitionSchedulingRepository implements CompetitionSchedulingRepository {
  public constructor(
    private readonly database: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async findDraft(request: {
    competitionId: string;
    guildId: string;
  }): Promise<{ createdByDiscordUserId: string; timezone: string } | 'not_found' | 'not_draft'> {
    const [competition] = await this.database
      .select({
        createdByDiscordUserId: competitions.createdByDiscordUserId,
        state: competitions.state,
        timezone: competitions.timezone,
      })
      .from(competitions)
      .where(
        and(eq(competitions.id, request.competitionId), eq(competitions.guildId, request.guildId)),
      );
    if (competition === undefined) return 'not_found';
    return competition.state === 'draft'
      ? {
          createdByDiscordUserId: competition.createdByDiscordUserId,
          timezone: competition.timezone,
        }
      : 'not_draft';
  }

  public async listDrafts(
    guildId: string,
  ): Promise<readonly { displayName: string; id: string }[]> {
    return this.database
      .select({ displayName: competitions.displayName, id: competitions.id })
      .from(competitions)
      .where(and(eq(competitions.guildId, guildId), eq(competitions.state, 'draft')))
      .orderBy(competitions.createdAt, competitions.id);
  }

  public async setIntendedStart(request: {
    competitionId: string;
    guildId: string;
    intendedStartAt: Date;
  }): Promise<boolean> {
    const [updated] = await this.database
      .update(competitions)
      .set({ intendedStartAt: request.intendedStartAt, updatedAt: this.now() })
      .where(
        and(
          eq(competitions.id, request.competitionId),
          eq(competitions.guildId, request.guildId),
          eq(competitions.state, 'draft'),
        ),
      )
      .returning({ id: competitions.id });
    return updated !== undefined;
  }
}
