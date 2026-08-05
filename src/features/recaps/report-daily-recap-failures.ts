import type { AuditService } from '../audit/audit-service.js';
import { createErrorReferenceId } from '../audit/error-reference.js';

import type {
  DailyRecapCollectionFailure,
  DailyRecapCollectionResult,
} from './daily-recap-collection.js';

export interface DailyRecapFailureAuditPublisher {
  publish(guildId: string, content: string): Promise<void>;
}

export interface DailyRecapFailureReporter {
  report(collection: DailyRecapCollectionResult): Promise<void>;
}

export class DailyRecapFailureAuditService implements DailyRecapFailureReporter {
  public constructor(
    private readonly audit: Pick<AuditService, 'record'>,
    private readonly publisher: DailyRecapFailureAuditPublisher,
    private readonly now: () => Date = () => new Date(),
    private readonly createErrorReference = createErrorReferenceId,
  ) {}

  public async report(collection: DailyRecapCollectionResult): Promise<void> {
    const failures = collection.outcomes.filter((outcome) => outcome.kind === 'failure');
    if (failures.length === 0) {
      return;
    }

    const errorReferenceId = this.createErrorReference();
    this.audit.record({
      context: {
        failedAccounts: failures.map((outcome) => ({
          accountId: outcome.account.id,
          failure: failureDetails(outcome.failure),
        })),
      },
      guildId: collection.guildId,
      errorReferenceId,
      occurredAt: this.now(),
      operation: 'daily_recap.account_fetch_failures',
      severity: 'warn',
      type: 'recap-or-scheduling-failure',
    });

    try {
      await this.publisher.publish(
        collection.guildId,
        renderDailyRecapFailureAudit(failures, errorReferenceId),
      );
    } catch {
      this.audit.record({
        context: { failedAccountCount: failures.length },
        errorReferenceId,
        guildId: collection.guildId,
        occurredAt: this.now(),
        operation: 'daily_recap.failure_audit_delivery_failed',
        severity: 'error',
        type: 'recap-or-scheduling-failure',
      });
    }
  }
}

export function renderDailyRecapFailureAudit(
  failures: readonly Extract<DailyRecapCollectionResult['outcomes'][number], { kind: 'failure' }>[],
  errorReferenceId: string,
): string {
  return [
    `**Daily recap account-fetch failures** (reference: ${errorReferenceId})`,
    ...failures.map(
      (outcome) =>
        `- ${outcome.account.displayUsername} (${outcome.account.id}): ${formatFailure(outcome.failure)}`,
    ),
  ].join('\n');
}

function failureDetails(failure: DailyRecapCollectionFailure): Record<string, unknown> {
  switch (failure.kind) {
    case 'baseline_incomplete':
    case 'incomplete_response':
      return { kind: failure.kind, missing: failure.missing };
    default:
      return { kind: failure.kind };
  }
}

function formatFailure(failure: DailyRecapCollectionFailure): string {
  switch (failure.kind) {
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
      return `Hiscores returned incomplete data (${failure.missing.join(', ')})`;
    case 'baseline_incomplete':
      return `stored recap baseline is incomplete (${failure.missing.join(', ')})`;
  }
}
