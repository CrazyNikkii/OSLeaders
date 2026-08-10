import { resolveScheduledCompetitionStart } from './resolve-scheduled-start.js';

export interface CompetitionSchedulePermissionEvaluator {
  evaluate(request: {
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
  }): Promise<{ canManageCompetitions: boolean }>;
}

export interface CompetitionSchedulingRepository {
  findDraft(request: {
    competitionId: string;
    guildId: string;
  }): Promise<{ createdByDiscordUserId: string; timezone: string } | 'not_found' | 'not_draft'>;
  setIntendedStart(request: {
    competitionId: string;
    guildId: string;
    intendedStartAt: Date;
  }): Promise<boolean>;
}

export type ScheduleCompetitionResult =
  | { kind: 'scheduled'; intendedStartAt: Date }
  | { kind: 'competition_not_found' }
  | { kind: 'forbidden' }
  | { kind: 'schedule_locked' }
  | {
      kind:
        'invalid_format' | 'invalid_timezone' | 'nonexistent_local_time' | 'ambiguous_local_time';
    };

/** Sets a draft's optional intended start without changing its lifecycle state. */
export class CompetitionSchedulingService {
  public constructor(
    private readonly repository: CompetitionSchedulingRepository,
    private readonly permissions: CompetitionSchedulePermissionEvaluator,
  ) {}

  public async schedule(request: {
    competitionId: string;
    guildId: string;
    hasAdministratorPermission: boolean;
    localDateTime: string;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
  }): Promise<ScheduleCompetitionResult> {
    const permissions = await this.permissions.evaluate({
      guildId: request.guildId,
      hasAdministratorPermission: request.hasAdministratorPermission,
      memberRoleIds: request.memberRoleIds,
    });
    const draft = await this.repository.findDraft({
      competitionId: request.competitionId,
      guildId: request.guildId,
    });
    if (draft === 'not_found') return { kind: 'competition_not_found' };
    if (draft === 'not_draft') return { kind: 'schedule_locked' };
    if (
      !permissions.canManageCompetitions &&
      draft.createdByDiscordUserId !== request.requesterDiscordUserId
    )
      return { kind: 'forbidden' };

    const resolution = resolveScheduledCompetitionStart(request.localDateTime, draft.timezone);
    if (resolution.kind !== 'resolved') return resolution;
    const scheduled = await this.repository.setIntendedStart({
      competitionId: request.competitionId,
      guildId: request.guildId,
      intendedStartAt: resolution.intendedStartAt,
    });
    return scheduled
      ? { kind: 'scheduled', intendedStartAt: resolution.intendedStartAt }
      : { kind: 'schedule_locked' };
  }
}
