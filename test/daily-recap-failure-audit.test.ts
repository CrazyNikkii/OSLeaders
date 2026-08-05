import { describe, expect, it, vi } from 'vitest';

import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import type { AuditService } from '../src/features/audit/audit-service.js';
import type { DailyRecapCollectionResult } from '../src/features/recaps/daily-recap-collection.js';
import {
  DailyRecapFailureAuditService,
  renderDailyRecapFailureAudit,
  type DailyRecapFailureAuditPublisher,
} from '../src/features/recaps/report-daily-recap-failures.js';
import type { StructuredLogEntry } from '../src/shared/structured-logging.js';

describe('daily recap failure audit service', () => {
  it('records and publishes a technical summary for each failed account', async () => {
    const audit = new AuditStub();
    const publisher = new PublisherStub();
    const service = new DailyRecapFailureAuditService(
      audit,
      publisher,
      () => new Date('2026-08-05'),
      () => 'err_recap_failure',
    );

    await service.report(collectionWithFailures());

    expect(audit.events).toEqual([
      expect.objectContaining({
        context: {
          failedAccounts: [
            { accountId: 'account-one', failure: { kind: 'timeout' } },
            {
              accountId: 'account-two',
              failure: { kind: 'incomplete_response', missing: ['skill:Attack'] },
            },
          ],
        },
        errorReferenceId: 'err_recap_failure',
        guildId: 'guild-one',
        operation: 'daily_recap.account_fetch_failures',
        type: 'recap-or-scheduling-failure',
      }),
    ]);
    expect(publisher.calls).toEqual([
      {
        content:
          '**Daily recap account-fetch failures** (reference: err_recap_failure)\n- Rune Scape (account-one): Hiscores request timed out\n- Unavailable (account-two): Hiscores returned incomplete data (skill:Attack)',
        guildId: 'guild-one',
      },
    ]);
  });

  it('does not emit an audit entry or Discord message without failed accounts', async () => {
    const audit = new AuditStub();
    const publisher = new PublisherStub();

    await new DailyRecapFailureAuditService(audit, publisher).report(collectionWithoutFailures());

    expect(audit.events).toEqual([]);
    expect(publisher.calls).toEqual([]);
  });

  it('contains an administrative channel failure without affecting the recap result', async () => {
    const audit = new AuditStub();
    const publisher: DailyRecapFailureAuditPublisher = {
      publish: vi.fn(() => Promise.reject(new Error('channel unavailable'))),
    };

    await expect(
      new DailyRecapFailureAuditService(audit, publisher).report(collectionWithFailures()),
    ).resolves.toBeUndefined();
    expect(audit.events.map((event) => event.operation)).toEqual([
      'daily_recap.account_fetch_failures',
      'daily_recap.failure_audit_delivery_failed',
    ]);
  });

  it('renders baseline failures without arbitrary upstream error text', () => {
    expect(
      renderDailyRecapFailureAudit(
        [
          {
            account: account('account-one', 'Rune Scape'),
            failure: { kind: 'baseline_incomplete', missing: ['skillExperience:Attack'] },
            kind: 'failure',
          },
        ],
        'err_recap_failure',
      ),
    ).toContain('stored recap baseline is incomplete (skillExperience:Attack)');
  });
});

class AuditStub {
  public readonly events: Parameters<AuditService['record']>[0][] = [];
  public readonly record = vi.fn((event: Parameters<AuditService['record']>[0]) => {
    this.events.push(event);
    return {
      operation: event.operation,
      severity: event.severity,
      timestamp: event.occurredAt.toISOString(),
    } satisfies StructuredLogEntry;
  });
}

class PublisherStub implements DailyRecapFailureAuditPublisher {
  public readonly calls: { content: string; guildId: string }[] = [];

  public publish(guildId: string, content: string): Promise<void> {
    this.calls.push({ content, guildId });
    return Promise.resolve();
  }
}

function account(id: string, displayUsername: string): TrackedAccount {
  return {
    accountMode: 'main',
    association: { type: 'watchlist' },
    createdAt: new Date('2026-08-01'),
    displayUsername,
    guildId: 'guild-one',
    id,
    isDefault: false,
    normalizedUsername: displayUsername.toLowerCase(),
    quotaOwnerDiscordUserId: 'member-one',
    registeredByDiscordUserId: 'member-one',
  };
}

function collectionWithFailures(): DailyRecapCollectionResult {
  return {
    completedAt: new Date('2026-08-05T12:01:00.000Z'),
    guildId: 'guild-one',
    outcomes: [
      {
        account: account('account-one', 'Rune Scape'),
        failure: { kind: 'timeout' },
        kind: 'failure',
      },
      {
        account: account('account-two', 'Unavailable'),
        failure: { kind: 'incomplete_response', missing: ['skill:Attack'] },
        kind: 'failure',
      },
    ],
    startedAt: new Date('2026-08-05T12:00:00.000Z'),
  };
}

function collectionWithoutFailures(): DailyRecapCollectionResult {
  return { ...collectionWithFailures(), outcomes: [] };
}
