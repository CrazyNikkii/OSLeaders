import type {
  CompetitionCreationRepository,
  CompetitionDraft,
} from '../../features/competitions/create-competition.js';
import type { Database } from './connection.js';
import { competitionRoles, competitions, guilds } from './schema/index.js';

export class PostgresCompetitionCreationRepository implements CompetitionCreationRepository {
  public constructor(private readonly database: Database) {}

  public async create(
    draft: CompetitionDraft,
  ): Promise<{ kind: 'created'; competition: CompetitionDraft } | { kind: 'name_taken' }> {
    return this.database.transaction(async (transaction) => {
      await transaction.insert(guilds).values({ guildId: draft.guildId }).onConflictDoNothing();
      const [stored] = await transaction
        .insert(competitions)
        .values({
          createdAt: draft.createdAt,
          createdByDiscordUserId: draft.createdByDiscordUserId,
          displayName: draft.displayName,
          durationSeconds: draft.durationSeconds,
          guildId: draft.guildId,
          id: draft.id,
          intendedStartAt: draft.intendedStartAt,
          metricKind: draft.metric.kind,
          metricName: draft.metric.name,
          normalizedName: draft.normalizedName,
          state: draft.state,
          targetValue: draft.targetValue,
          timezone: draft.timezone,
          type: draft.type,
          updatedAt: draft.updatedAt,
        })
        .onConflictDoNothing({ target: [competitions.guildId, competitions.normalizedName] })
        .returning();
      if (stored !== undefined) {
        await transaction.insert(competitionRoles).values({
          competitionId: stored.id,
          guildId: stored.guildId,
        });
      }
      return stored === undefined
        ? { kind: 'name_taken' }
        : { kind: 'created', competition: toCompetitionDraft(stored) };
    });
  }
}

function toCompetitionDraft(stored: typeof competitions.$inferSelect): CompetitionDraft {
  if (stored.state !== 'draft') {
    throw new Error('A newly created competition must be in the draft state.');
  }
  return {
    createdAt: stored.createdAt,
    createdByDiscordUserId: stored.createdByDiscordUserId,
    displayName: stored.displayName,
    durationSeconds: stored.durationSeconds,
    guildId: stored.guildId,
    id: stored.id,
    intendedStartAt: requiredIntendedStartAt(stored.intendedStartAt),
    metric: { kind: stored.metricKind, name: stored.metricName },
    normalizedName: stored.normalizedName,
    state: stored.state,
    targetValue: stored.targetValue,
    timezone: stored.timezone,
    type: stored.type,
    updatedAt: stored.updatedAt,
  };
}

function requiredIntendedStartAt(value: Date | null): Date {
  if (value === null) throw new Error('A newly created competition must have an intended start.');
  return value;
}
