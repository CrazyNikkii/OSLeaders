import { describe, expect, it, vi } from 'vitest';

import {
  CompetitionRoleLifecycleService,
  CompetitionRolePermissionError,
  MissingCompetitionRoleError,
  type PendingCompetitionRoleOperation,
  type CompetitionRolePublisher,
  type CompetitionRoleRepository,
} from '../src/features/competitions/manage-competition-role.js';

const operation = {
  attemptCount: 1,
  competitionId: 'competition-1',
  creatorDiscordUserId: 'creator-1',
  displayName: 'Winter grind',
  discordRoleId: null,
  guildId: 'guild-1',
  memberDiscordUserIds: ['member-1'],
  operation: 'create' as const,
};

describe('CompetitionRoleLifecycleService', () => {
  it('creates and records a role only after Discord setup succeeds', async () => {
    const repository = fakeRepository(operation);
    const publisher: CompetitionRolePublisher = {
      cleanup: vi.fn(),
      createAndAssign: vi.fn().mockResolvedValue({ discordRoleId: 'role-1' }),
      syncAssignments: vi.fn(),
    };
    const service = new CompetitionRoleLifecycleService(repository, publisher);

    await expect(service.recoverDue()).resolves.toBe('completed');
    expect(repository.recordCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        competitionId: 'competition-1',
        discordRoleId: 'role-1',
        guildId: 'guild-1',
      }),
    );
    expect(repository.recordFailure).not.toHaveBeenCalled();
  });

  it('retries normal Discord failures without losing durable role work', async () => {
    const repository = fakeRepository(operation);
    const publisher: CompetitionRolePublisher = {
      cleanup: vi.fn(),
      createAndAssign: vi.fn().mockRejectedValue(new Error('Missing Manage Roles permission')),
      syncAssignments: vi.fn(),
    };
    const service = new CompetitionRoleLifecycleService(
      repository,
      publisher,
      () => new Date(1_000),
    );

    await expect(service.recoverDue()).resolves.toBe('failed');
    expect(repository.recordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        competitionId: 'competition-1',
        failureSummary: 'Missing Manage Roles permission',
        guildId: 'guild-1',
        nextAttemptAt: new Date(61_000),
        operation: 'create',
      }),
    );
  });

  it('recreates a manually deleted active role instead of retrying its stale Discord ID', async () => {
    const repository = fakeRepository({ ...operation, discordRoleId: 'role-1', operation: 'sync' });
    const publisher: CompetitionRolePublisher = {
      cleanup: vi.fn(),
      createAndAssign: vi.fn(),
      syncAssignments: vi.fn().mockRejectedValue(new MissingCompetitionRoleError('Role missing')),
    };
    const service = new CompetitionRoleLifecycleService(repository, publisher);

    await expect(service.recoverDue()).resolves.toBe('failed');
    expect(repository.recordMissingRole).toHaveBeenCalledWith(
      expect.objectContaining({ discordRoleId: 'role-1', operation: 'sync' }),
    );
    expect(repository.recordFailure).not.toHaveBeenCalled();
  });

  it('warns through the failure reporter when Discord denies role management', async () => {
    const repository = fakeRepository(operation);
    const failures = { report: vi.fn().mockResolvedValue(undefined) };
    const publisher: CompetitionRolePublisher = {
      cleanup: vi.fn(),
      createAndAssign: vi
        .fn()
        .mockRejectedValue(new CompetitionRolePermissionError('Permission denied')),
      syncAssignments: vi.fn(),
    };
    const service = new CompetitionRoleLifecycleService(repository, publisher, undefined, failures);

    await expect(service.recoverDue()).resolves.toBe('failed');
    expect(failures.report).toHaveBeenCalledWith(operation, 'Permission denied');
  });
});

function fakeRepository(next: PendingCompetitionRoleOperation) {
  return {
    claimDueOperation: vi.fn().mockResolvedValue(next),
    recordCleaned: vi.fn().mockResolvedValue(undefined),
    recordCreated: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    recordMissingRole: vi.fn().mockResolvedValue(undefined),
    recordSynced: vi.fn().mockResolvedValue(undefined),
  } satisfies CompetitionRoleRepository & Record<string, ReturnType<typeof vi.fn>>;
}
