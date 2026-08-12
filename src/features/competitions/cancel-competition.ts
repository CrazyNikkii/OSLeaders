export interface CompetitionCancellationPermissionEvaluator {
  evaluate(request: {
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
  }): Promise<{ canManageCompetitions: boolean }>;
}

export interface CompetitionCancellationRepository {
  cancel(request: {
    canManageCompetitions: boolean;
    competitionId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionCancellationResult>;
}

export type CompetitionCancellationResult =
  | { kind: 'cancelled'; competitionId: string; displayName: string; guildId: string }
  | { kind: 'competition_not_found' | 'forbidden' | 'cancellation_locked' };

/** Durably cancels a competition before optional Discord role cleanup occurs. */
export class CompetitionCancellationService {
  public constructor(
    private readonly repository: CompetitionCancellationRepository,
    private readonly permissions: CompetitionCancellationPermissionEvaluator,
    private readonly audit?: {
      record(event: {
        type: 'competition-lifecycle';
        severity: 'info';
        operation: string;
        occurredAt: Date;
        guildId: string;
        context: Record<string, unknown>;
      }): unknown;
    },
  ) {}

  public async cancel(request: {
    competitionId: string;
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
  }): Promise<CompetitionCancellationResult> {
    const permissions = await this.permissions.evaluate({
      guildId: request.guildId,
      hasAdministratorPermission: request.hasAdministratorPermission,
      memberRoleIds: request.memberRoleIds,
    });
    const result = await this.repository.cancel({
      canManageCompetitions: permissions.canManageCompetitions,
      competitionId: request.competitionId,
      guildId: request.guildId,
      requesterDiscordUserId: request.requesterDiscordUserId,
    });
    if (result.kind === 'cancelled')
      try {
        this.audit?.record({
          type: 'competition-lifecycle',
          severity: 'info',
          operation: 'competition.cancelled',
          occurredAt: new Date(),
          guildId: result.guildId,
          context: {
            competitionId: result.competitionId,
            requesterDiscordUserId: request.requesterDiscordUserId,
          },
        });
      } catch {
        // Administrative logging is optional and must not undo a durable cancellation.
      }
    return result;
  }
}
