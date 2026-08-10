import type { HiscoreFailure } from '../../infrastructure/hiscores/hiscore-result.js';

import type { AuditService } from '../audit/audit-service.js';
import { createErrorReferenceId } from '../audit/error-reference.js';

import type { TimedCompetitionFinalizationAccount } from './finalize-timed-competition.js';

export interface TimedCompetitionFinalizationFailureReporter {
  report(
    guildId: string,
    failures: readonly { account: TimedCompetitionFinalizationAccount; failure: HiscoreFailure }[],
  ): Promise<void>;
}

export class TimedCompetitionFinalizationFailureAuditService implements TimedCompetitionFinalizationFailureReporter {
  public constructor(
    private readonly audit: Pick<AuditService, 'record'>,
    private readonly publisher: { publish(guildId: string, content: string): Promise<void> },
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async report(
    guildId: string,
    failures: readonly { account: TimedCompetitionFinalizationAccount; failure: HiscoreFailure }[],
  ): Promise<void> {
    const errorReferenceId = createErrorReferenceId();
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
      operation: 'competition.timed_finish_fetch_failures',
      severity: 'warn',
      type: 'competition-lifecycle',
    });
    try {
      await this.publisher.publish(
        guildId,
        `**Timed competition finish pending** (reference: ${errorReferenceId})\n${failures.map(({ account, failure }) => `- ${account.displayUsername} (${account.id}): ${failure.kind}`).join('\n')}`,
      );
    } catch {
      this.audit.record({
        context: { failedAccountCount: failures.length },
        errorReferenceId,
        guildId,
        occurredAt: this.now(),
        operation: 'competition.timed_finish_audit_delivery_failed',
        severity: 'error',
        type: 'competition-lifecycle',
      });
    }
  }
}
