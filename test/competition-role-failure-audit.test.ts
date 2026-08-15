import { describe, expect, it, vi } from 'vitest';

import { CompetitionRoleFailureAuditService } from '../src/features/competitions/report-competition-role-failures.js';

describe('CompetitionRoleFailureAuditService', () => {
  it('records a role-management audit event and warns the competition creator', async () => {
    const audit = { record: vi.fn() };
    const publisher = { warnCreator: vi.fn().mockResolvedValue(undefined) };
    const service = new CompetitionRoleFailureAuditService(
      audit,
      publisher,
      () => new Date('2026-08-11T12:00:00.000Z'),
      () => 'err_role_permission',
    );

    await service.report(
      {
        attemptCount: 1,
        competitionId: 'competition-one',
        creatorDiscordUserId: 'creator-one',
        displayName: 'Winter grind',
        discordRoleId: null,
        guildId: 'guild-one',
        leaseExpiresAt: new Date('2026-08-15T12:05:00.000Z'),
        memberDiscordUserIds: [],
        operation: 'create',
      },
      'Discord denied the bot permission to manage this role.',
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        errorReferenceId: 'err_role_permission',
        operation: 'competition.role_permission_failure',
        type: 'role-management-failure',
      }),
    );
    expect(publisher.warnCreator).toHaveBeenCalledWith(
      expect.objectContaining({
        creatorDiscordUserId: 'creator-one',
        guildId: 'guild-one',
        content:
          "I could not manage the temporary role for **Winter grind**. The competition will continue without it while I retry. Please check the bot's Manage Roles permission and role hierarchy. Reference: err_role_permission",
      }),
    );
  });
});
