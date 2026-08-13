import { describe, expect, it, vi } from 'vitest';

import {
  TimedCompetitionFinalizationService,
  type TimedCompetitionFinalizationRepository,
} from '../src/features/competitions/finalize-timed-competition.js';
import { TimedCompetitionFinalizationFailureAuditService } from '../src/features/competitions/report-timed-competition-finalization-failures.js';
import type { AuditEvent } from '../src/features/audit/audit-event.js';

describe('timed competition finalization', () => {
  it('bypasses the cache, retains final values, and marks a delayed result', async () => {
    const repository = new Finals();
    const service = new TimedCompetitionFinalizationService(
      repository,
      {
        fetchHiscores: (_endpoint, username) =>
          Promise.resolve(response(username === 'one' ? 150 : 250)),
      },
      () => new Date('2026-08-10T12:01:00.000Z'),
    );

    await expect(service.finalizeDue()).resolves.toMatchObject({
      kind: 'finished',
      isResultDelayed: true,
      winnerEntrantIds: ['entrant-one', 'entrant-two'],
    });
    expect(repository.completed[0]).toMatchObject({
      isResultDelayed: true,
      finalValues: [
        { accountId: 'account-one', entrantId: 'entrant-one', value: 150n },
        { accountId: 'account-two', entrantId: 'entrant-two', value: 250n },
      ],
    });
  });

  it('does not mark a result delayed when final collection starts at the exact deadline', async () => {
    const finalizedAt = new Date('2026-08-10T12:00:00.000Z');
    const repository = new Finals();
    repository.endsAt = finalizedAt;
    const service = new TimedCompetitionFinalizationService(
      repository,
      { fetchHiscores: () => Promise.resolve(response(150)) },
      () => finalizedAt,
    );

    await expect(service.finalizeDue()).resolves.toMatchObject({
      kind: 'finished',
      isResultDelayed: false,
    });
    expect(repository.completed[0]?.isResultDelayed).toBe(false);
  });

  it('retries each final fetch once and preserves finish-pending on failure', async () => {
    const repository = new Finals();
    let fetchCount = 0;
    const service = new TimedCompetitionFinalizationService(repository, {
      fetchHiscores: () => {
        fetchCount += 1;
        return Promise.resolve({ kind: 'timeout' as const });
      },
    });

    await expect(service.finalizeDue()).resolves.toMatchObject({ kind: 'finish_pending' });
    expect(fetchCount).toBe(4);
    expect(repository.retries).toHaveLength(1);
    expect(repository.completed).toEqual([]);
  });

  it('reports timed-finalization failures without calling them target races', async () => {
    const record = vi.fn();
    const publish = vi.fn(() => Promise.resolve());
    const reporter = new TimedCompetitionFinalizationFailureAuditService(
      { record },
      { publish },
      () => new Date('2026-08-10T12:00:00.000Z'),
    );

    await reporter.report('guild-one', [
      {
        account: {
          accountMode: 'main',
          competitionEntrantId: 'entrant-one',
          displayUsername: 'one',
          id: 'account-one',
          startingValue: 100n,
        },
        failure: { kind: 'timeout' },
      },
    ]);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'competition.timed_finish_fetch_failures' }),
    );
    expect(publish).toHaveBeenCalledWith(
      'guild-one',
      expect.stringContaining('Timed competition finish pending'),
    );
  });

  it('authorizes a creator-or-manager manual finish and reuses the durable finalization path', async () => {
    const repository = new Finals();
    const service = new TimedCompetitionFinalizationService(
      repository,
      { fetchHiscores: () => Promise.resolve(response(150)) },
      () => new Date('2026-08-10T11:00:00.000Z'),
    );

    await expect(
      service.finalizeManually(
        {
          competitionId: 'competition-one',
          guildId: 'guild-one',
          hasAdministratorPermission: false,
          memberRoleIds: [],
          requesterDiscordUserId: 'creator-one',
        },
        { evaluate: () => Promise.resolve({ canManageCompetitions: false }) },
      ),
    ).resolves.toMatchObject({ kind: 'finished', isResultDelayed: false });
    expect(repository.manualRequests).toEqual([
      expect.objectContaining({
        canManageCompetitions: false,
        requesterDiscordUserId: 'creator-one',
      }),
    ]);
    expect(repository.completed).toHaveLength(1);
  });

  it('does not fetch Hiscores when manual finalization is forbidden', async () => {
    const repository = new Finals({ kind: 'forbidden' });
    const fetchHiscores = vi.fn(() => Promise.resolve(response(150)));
    const service = new TimedCompetitionFinalizationService(repository, { fetchHiscores });

    await expect(
      service.finalizeManually(
        {
          competitionId: 'competition-one',
          guildId: 'guild-one',
          hasAdministratorPermission: false,
          memberRoleIds: [],
          requesterDiscordUserId: 'member-one',
        },
        { evaluate: () => Promise.resolve({ canManageCompetitions: false }) },
      ),
    ).resolves.toEqual({ kind: 'forbidden' });
    expect(fetchHiscores).not.toHaveBeenCalled();
  });

  it('records a successful manual completion without allowing audit failure to undo it', async () => {
    const auditEvents: AuditEvent[] = [];
    const audit = {
      record: (event: AuditEvent) => {
        auditEvents.push(event);
        throw new Error('unavailable');
      },
    };
    const service = new TimedCompetitionFinalizationService(
      new Finals(),
      { fetchHiscores: () => Promise.resolve(response(150)) },
      () => new Date('2026-08-10T11:00:00.000Z'),
      undefined,
      audit,
    );

    await expect(
      service.finalizeManually(
        {
          competitionId: 'competition-one',
          guildId: 'guild-one',
          hasAdministratorPermission: false,
          memberRoleIds: [],
          requesterDiscordUserId: 'creator-one',
        },
        { evaluate: () => Promise.resolve({ canManageCompetitions: false }) },
      ),
    ).resolves.toMatchObject({ kind: 'finished' });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      context: {
        competitionId: 'competition-one',
        outcome: 'finished',
        requesterDiscordUserId: 'creator-one',
      },
      guildId: 'guild-one',
      operation: 'competition.manual_finalization',
      type: 'competition-lifecycle',
    });
  });
});

class Finals implements TimedCompetitionFinalizationRepository {
  public endsAt = new Date('2026-08-10T12:00:00.000Z');
  public readonly completed: Parameters<
    TimedCompetitionFinalizationRepository['completeFinalization']
  >[0][] = [];
  public readonly retries: Parameters<
    TimedCompetitionFinalizationRepository['scheduleRetry']
  >[0][] = [];
  public readonly manualRequests: Parameters<
    TimedCompetitionFinalizationRepository['beginManualFinalization']
  >[0][] = [];

  public constructor(
    private readonly manualResult: { kind: 'forbidden' } | undefined = undefined,
  ) {}

  public beginManualFinalization(
    request: Parameters<TimedCompetitionFinalizationRepository['beginManualFinalization']>[0],
  ) {
    this.manualRequests.push(request);
    if (this.manualResult !== undefined) return Promise.resolve(this.manualResult);
    return this.claimDueFinalization().then((competition) => {
      if (competition === undefined) return { kind: 'finalization_locked' as const };
      return { kind: 'ready_to_finalize' as const, competition };
    });
  }

  public claimDueFinalization() {
    return Promise.resolve({
      accounts: [
        {
          accountMode: 'main' as const,
          competitionEntrantId: 'entrant-one',
          displayUsername: 'one',
          id: 'account-one',
          startingValue: 100n,
        },
        {
          accountMode: 'main' as const,
          competitionEntrantId: 'entrant-two',
          displayUsername: 'two',
          id: 'account-two',
          startingValue: 200n,
        },
      ],
      competitionId: 'competition-one',
      endsAt: this.endsAt,
      finishAttemptCount: 1,
      guildId: 'guild-one',
      metric: { kind: 'skill' as const, name: 'Attack' },
    });
  }

  public completeFinalization(
    request: Parameters<TimedCompetitionFinalizationRepository['completeFinalization']>[0],
  ) {
    this.completed.push(request);
    return Promise.resolve({
      kind: 'finished' as const,
      winnerEntrantIds: ['entrant-one', 'entrant-two'],
    });
  }

  public scheduleRetry(
    request: Parameters<TimedCompetitionFinalizationRepository['scheduleRetry']>[0],
  ) {
    this.retries.push(request);
    return Promise.resolve();
  }
}

function response(experience: number) {
  return {
    kind: 'success' as const,
    data: {
      activities: [],
      bosses: [],
      returnedName: 'name',
      skills: [{ experience, id: 0, level: 1, name: 'Attack' as const, rank: 1 }],
    },
  };
}
