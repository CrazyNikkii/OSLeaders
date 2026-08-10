import type { AuditService } from '../audit/audit-service.js';
import { createErrorReferenceId } from '../audit/error-reference.js';

import type { CompetitionStartFailure } from './start-competition.js';

export interface CompetitionStartFailureAuditPublisher {
  publish(guildId: string, content: string): Promise<void>;
}

export interface CompetitionStartFailureReporter {
  report(guildId: string, failures: readonly CompetitionStartFailure[]): Promise<void>;
}

export class CompetitionStartFailureAuditService implements CompetitionStartFailureReporter {
  public constructor(
    private readonly audit: Pick<AuditService, 'record'>,
    private readonly publisher: CompetitionStartFailureAuditPublisher,
    private readonly now: () => Date = () => new Date(),
    private readonly createErrorReference = createErrorReferenceId,
  ) {}

  public async report(
    guildId: string,
    failures: readonly CompetitionStartFailure[],
  ): Promise<void> {
    const errorReferenceId = this.createErrorReference();
    this.audit.record({
      context: {
        failedAccounts: failures.map(({ account, failure }) => ({
          accountId: account.id,
          failure: failure.kind,
        })),
      },
      errorReferenceId,
      guildId,
      occurredAt: this.now(),
      operation: 'competition.start_fetch_failures',
      severity: 'warn',
      type: 'competition-lifecycle',
    });
    try {
      await this.publisher.publish(
        guildId,
        renderCompetitionStartFailureAudit(failures, errorReferenceId),
      );
    } catch {
      this.audit.record({
        context: { failedAccountCount: failures.length },
        errorReferenceId,
        guildId,
        occurredAt: this.now(),
        operation: 'competition.start_failure_audit_delivery_failed',
        severity: 'error',
        type: 'competition-lifecycle',
      });
    }
  }
}

export function renderCompetitionStartFailureAudit(
  failures: readonly CompetitionStartFailure[],
  errorReferenceId: string,
): string {
  return [
    `**Competition start pending** (reference: ${errorReferenceId})`,
    ...failures.map(
      ({ account, failure }) =>
        `- ${account.displayUsername} (${account.id}): ${formatFailure(failure.kind)}`,
    ),
  ].join('\n');
}

function formatFailure(kind: CompetitionStartFailure['failure']['kind']): string {
  switch (kind) {
    case 'not_found':
      return 'not found on Hiscores';
    case 'timeout':
      return 'Hiscores request timed out';
    case 'temporary_upstream_failure':
      return 'Hiscores is temporarily unavailable';
    case 'mode_incompatible':
      return 'account mode is incompatible with Hiscores';
    case 'malformed_response':
      return 'Hiscores returned malformed data';
    case 'incomplete_response':
      return 'Hiscores returned incomplete data';
  }
}
