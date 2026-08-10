import { describe, expect, it } from 'vitest';

import {
  CompetitionStartService,
  type CompetitionReadyToStart,
  type CompetitionStartHiscoreFetcher,
  type CompetitionStartRepository,
  type CompetitionStartingSnapshot,
} from '../src/features/competitions/start-competition.js';
import type { CompetitionStartHiscoreResult } from '../src/features/competitions/start-competition.js';
import type { CompetitionMetric } from '../src/features/competitions/create-competition.js';
import type { OsrsHiscoreEndpoint } from '../src/infrastructure/hiscores/osrs-hiscore-catalog.js';

describe('competition start service', () => {
  it('takes fresh starting snapshots and activates a timed competition at the successful snapshot time', async () => {
    const repository = new StartRepository();
    const service = new CompetitionStartService(
      repository,
      permissions(true),
      new Hiscores({ 'Rune Scape': skillResult(123456) }),
      () => new Date('2026-08-10T12:00:00.000Z'),
    );

    await expect(service.start(request())).resolves.toMatchObject({
      kind: 'started',
      endsAt: new Date('2026-08-11T12:00:00.000Z'),
      startedAt: new Date('2026-08-10T12:00:00.000Z'),
    });
    expect(repository.completed).toMatchObject([
      {
        snapshots: [{ account: { id: 'account-one' }, value: 123456n }],
      },
    ]);
    expect(repository.started).toBe(true);
    expect(repository.scheduledRetries).toEqual([]);
  });

  it('leaves the durable start pending when any fresh snapshot fails, then permits retry', async () => {
    const repository = new StartRepository();
    const hiscores = new Hiscores({ 'Rune Scape': { kind: 'temporary_upstream_failure' } });
    const service = new CompetitionStartService(repository, permissions(true), hiscores);

    await expect(service.start(request())).resolves.toMatchObject({
      kind: 'start_pending',
      failures: [
        { account: { id: 'account-one' }, failure: { kind: 'temporary_upstream_failure' } },
      ],
    });
    expect(repository.started).toBe(false);
    expect(repository.scheduledRetries).toEqual([
      expect.objectContaining({ failureSummary: 'account-one:temporary_upstream_failure' }),
    ]);
    hiscores.responses['Rune Scape'] = skillResult(123456);
    await expect(service.start(request())).resolves.toMatchObject({ kind: 'started' });
    expect(hiscores.options).toEqual([{ cacheMode: 'bypass' }, { cacheMode: 'bypass' }]);
  });

  it('normalizes an unranked boss score to a zero-KC starting snapshot', async () => {
    const repository = new StartRepository({ kind: 'boss', name: 'Maggot King' });
    const service = new CompetitionStartService(
      repository,
      permissions(true),
      new Hiscores({ 'Rune Scape': bossResult(-1) }),
    );

    await expect(service.start(request())).resolves.toMatchObject({ kind: 'started' });
    expect(repository.completed).toMatchObject([
      { snapshots: [{ account: { id: 'account-one' }, value: 0n }] },
    ]);
  });

  it('requires manager permission or the draft creator and preserves guild-scoped start requests', async () => {
    const repository = new StartRepository();
    const service = new CompetitionStartService(
      repository,
      permissions(false),
      new Hiscores({ 'Rune Scape': skillResult(123456) }),
    );

    await expect(
      service.start(request({ requesterDiscordUserId: 'member-one' })),
    ).resolves.toMatchObject({
      kind: 'started',
    });
    await expect(service.start(request({ requesterDiscordUserId: 'member-two' }))).resolves.toEqual(
      {
        kind: 'forbidden',
      },
    );
    await expect(service.start(request({ guildId: 'guild-two' }))).resolves.toEqual({
      kind: 'competition_not_found',
    });
  });
});

class StartRepository implements CompetitionStartRepository {
  public readonly completed: { snapshots: readonly CompetitionStartingSnapshot[] }[] = [];
  public readonly scheduledRetries: { failureSummary: string; nextAttemptAt: Date }[] = [];
  public started = false;
  private pending = false;
  public constructor(
    private readonly metric: CompetitionMetric = { kind: 'skill', name: 'Woodcutting' },
  ) {}

  public beginStart(request: {
    canManageCompetitions: boolean;
    competitionId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }) {
    if (request.guildId !== 'guild-one')
      return Promise.resolve({ kind: 'competition_not_found' as const });
    if (!request.canManageCompetitions && request.requesterDiscordUserId !== 'member-one') {
      return Promise.resolve({ kind: 'forbidden' as const });
    }
    if (this.started) return Promise.resolve({ kind: 'start_locked' as const });
    this.pending = true;
    return Promise.resolve({
      kind: 'ready_to_start' as const,
      competition: competition(this.metric),
    });
  }

  public completeStart(request: {
    competitionId: string;
    guildId: string;
    snapshots: readonly CompetitionStartingSnapshot[];
    startedAt: Date;
  }) {
    if (!this.pending || this.started) return Promise.resolve({ kind: 'start_locked' as const });
    this.completed.push({ snapshots: request.snapshots });
    this.started = true;
    return Promise.resolve({
      kind: 'started' as const,
      competitionId: request.competitionId,
      guildId: request.guildId,
      startedAt: request.startedAt,
      endsAt: new Date(request.startedAt.getTime() + 86_400_000),
    });
  }

  public scheduleRetry(request: { failureSummary: string; nextAttemptAt: Date }): Promise<void> {
    this.scheduledRetries.push(request);
    return Promise.resolve();
  }

  public claimDueStart(): Promise<CompetitionReadyToStart | undefined> {
    return Promise.resolve(undefined);
  }
}

class Hiscores implements CompetitionStartHiscoreFetcher {
  public readonly options: { cacheMode: 'bypass' }[] = [];
  public constructor(public readonly responses: Record<string, CompetitionStartHiscoreResult>) {}
  public fetchHiscores(
    _endpoint: OsrsHiscoreEndpoint,
    username: string,
    options: { cacheMode: 'bypass' },
  ) {
    this.options.push(options);
    return Promise.resolve(this.responses[username]!);
  }
}

function competition(
  metric: CompetitionMetric = { kind: 'skill', name: 'Woodcutting' },
): CompetitionReadyToStart {
  return {
    accounts: [
      {
        accountMode: 'main',
        association: { type: 'linked', discordUserId: 'member-one' },
        competitionEntrantId: 'entrant-one',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        displayUsername: 'Rune Scape',
        guildId: 'guild-one',
        id: 'account-one',
        isDefault: true,
        normalizedUsername: 'rune scape',
        quotaOwnerDiscordUserId: 'member-one',
        registeredByDiscordUserId: 'member-one',
      },
    ],
    competitionId: 'competition-one',
    durationSeconds: 86400,
    guildId: 'guild-one',
    metric,
    startAttemptCount: 1,
  };
}

function skillResult(experience: number) {
  return {
    kind: 'success' as const,
    data: {
      activities: [],
      bosses: [],
      returnedName: 'Rune Scape',
      skills: [{ id: 8, level: 1, name: 'Woodcutting' as const, experience, rank: 1 }],
    },
  };
}

function bossResult(score: number) {
  return {
    kind: 'success' as const,
    data: {
      activities: [],
      bosses: [{ id: 35, name: 'Maggot King' as const, rank: -1, score }],
      returnedName: 'Rune Scape',
      skills: [],
    },
  };
}

function permissions(canManageCompetitions: boolean) {
  return { evaluate: () => Promise.resolve({ canManageCompetitions }) };
}

function request(
  overrides: Partial<{
    guildId: string;
    requesterDiscordUserId: string;
  }> = {},
) {
  return {
    competitionId: 'competition-one',
    guildId: 'guild-one',
    hasAdministratorPermission: false,
    memberRoleIds: [],
    requesterDiscordUserId: 'manager-one',
    ...overrides,
  };
}
