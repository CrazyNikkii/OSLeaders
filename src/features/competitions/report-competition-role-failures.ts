import type { AuditService } from '../audit/audit-service.js';
import { createErrorReferenceId } from '../audit/error-reference.js';

import type {
  CompetitionRoleFailureReporter,
  PendingCompetitionRoleOperation,
} from './manage-competition-role.js';

export interface CompetitionRoleFailurePublisher {
  warnCreator(request: {
    content: string;
    creatorDiscordUserId: string;
    guildId: string;
  }): Promise<void>;
}

export class CompetitionRoleFailureAuditService implements CompetitionRoleFailureReporter {
  public constructor(
    private readonly audit: Pick<AuditService, 'record'>,
    private readonly publisher: CompetitionRoleFailurePublisher,
    private readonly now: () => Date = () => new Date(),
    private readonly createErrorReference = createErrorReferenceId,
  ) {}

  public async report(
    operation: PendingCompetitionRoleOperation,
    failureSummary: string,
  ): Promise<void> {
    const errorReferenceId = this.createErrorReference();
    this.audit.record({
      context: {
        competitionId: operation.competitionId,
        failure: failureSummary,
        roleOperation: operation.operation,
      },
      errorReferenceId,
      guildId: operation.guildId,
      occurredAt: this.now(),
      operation: 'competition.role_permission_failure',
      severity: 'warn',
      type: 'role-management-failure',
    });
    try {
      await this.publisher.warnCreator({
        content: `I could not manage the temporary role for **${operation.displayName}**. The competition will continue without it while I retry. Please check the bot's Manage Roles permission and role hierarchy. Reference: ${errorReferenceId}`,
        creatorDiscordUserId: operation.creatorDiscordUserId,
        guildId: operation.guildId,
      });
    } catch {
      this.audit.record({
        context: { competitionId: operation.competitionId },
        errorReferenceId,
        guildId: operation.guildId,
        occurredAt: this.now(),
        operation: 'competition.role_creator_warning_failed',
        severity: 'error',
        type: 'role-management-failure',
      });
    }
  }
}
