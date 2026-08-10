import { describe, expect, it, vi } from 'vitest';

import type { AuditEvent } from '../src/features/audit/audit-event.js';
import {
  CompetitionStartFailureAuditService,
  renderCompetitionStartFailureAudit,
} from '../src/features/competitions/report-competition-start-failures.js';
import type { CompetitionStartFailure } from '../src/features/competitions/start-competition.js';

describe('competition start failure audit service', () => {
  it('records and publishes a sanitized failure summary', async () => {
    const audit = new AuditStub();
    const publish = vi.fn(() => Promise.resolve());
    const service = new CompetitionStartFailureAuditService(
      audit,
      { publish },
      () => new Date('2026-08-10T12:00:00.000Z'),
      () => 'err_competition_start',
    );

    await service.report('guild-one', [failure()]);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { failedAccounts: [{ accountId: 'account-one', failure: 'timeout' }] },
        operation: 'competition.start_fetch_failures',
      }),
    );
    expect(publish).toHaveBeenCalledWith(
      'guild-one',
      '**Competition start pending** (reference: err_competition_start)\n- Rune Scape (account-one): Hiscores request timed out',
    );
  });

  it('contains administrative delivery failure', async () => {
    const audit = new AuditStub();
    await expect(
      new CompetitionStartFailureAuditService(audit, {
        publish: vi.fn(() => Promise.reject(new Error('channel unavailable'))),
      }).report('guild-one', [failure()]),
    ).resolves.toBeUndefined();
    expect(audit.events.map((event) => event.operation)).toEqual([
      'competition.start_fetch_failures',
      'competition.start_failure_audit_delivery_failed',
    ]);
  });

  it('does not expose arbitrary upstream error text', () => {
    expect(renderCompetitionStartFailureAudit([failure()], 'err_one')).not.toContain('upstream');
  });
});

class AuditStub {
  public readonly events: AuditEvent[] = [];

  public readonly record = vi.fn((event: AuditEvent) => {
    this.events.push(event);
    return {
      operation: event.operation,
      severity: event.severity,
      timestamp: event.occurredAt.toISOString(),
    };
  });
}

function failure(): CompetitionStartFailure {
  return {
    account: {
      accountMode: 'main',
      association: { type: 'linked', discordUserId: 'member-one' },
      competitionEntrantId: 'entrant-one',
      createdAt: new Date('2026-08-01'),
      displayUsername: 'Rune Scape',
      guildId: 'guild-one',
      id: 'account-one',
      isDefault: true,
      normalizedUsername: 'rune scape',
      quotaOwnerDiscordUserId: 'member-one',
      registeredByDiscordUserId: 'member-one',
    },
    failure: { kind: 'timeout' },
  };
}
