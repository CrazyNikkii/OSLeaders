import { describe, expect, it } from 'vitest';

import {
  CompetitionSchedulingService,
  type CompetitionSchedulingRepository,
} from '../src/features/competitions/schedule-competition.js';

describe('competition scheduling', () => {
  it('lets the creator set a draft start using the draft timezone', async () => {
    const repository = new Repository();
    const service = new CompetitionSchedulingService(repository, new Permissions(false));

    await expect(
      service.schedule({
        competitionId: 'competition-one',
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        localDateTime: '2026-08-10 15:30',
        memberRoleIds: [],
        requesterDiscordUserId: 'creator-one',
      }),
    ).resolves.toEqual({
      kind: 'scheduled',
      intendedStartAt: new Date('2026-08-10T12:30:00.000Z'),
    });
    expect(repository.request).toEqual({
      competitionId: 'competition-one',
      guildId: 'guild-one',
      intendedStartAt: new Date('2026-08-10T12:30:00.000Z'),
    });
  });

  it('requires the creator or a competition manager, retains guild isolation, and preserves draft-only state', async () => {
    const repository = new Repository();
    const service = new CompetitionSchedulingService(repository, new Permissions(false));

    await expect(
      service.schedule({
        competitionId: 'competition-one',
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        localDateTime: '2026-08-10 15:30',
        memberRoleIds: [],
        requesterDiscordUserId: 'member-two',
      }),
    ).resolves.toEqual({ kind: 'forbidden' });

    repository.result = 'not_draft';
    await expect(
      service.schedule({
        competitionId: 'competition-one',
        guildId: 'guild-one',
        hasAdministratorPermission: false,
        localDateTime: '2026-08-10 15:30',
        memberRoleIds: [],
        requesterDiscordUserId: 'creator-one',
      }),
    ).resolves.toEqual({ kind: 'schedule_locked' });

    repository.result = 'not_found';
    await expect(
      service.schedule({
        competitionId: 'competition-one',
        guildId: 'guild-two',
        hasAdministratorPermission: false,
        localDateTime: '2026-08-10 15:30',
        memberRoleIds: [],
        requesterDiscordUserId: 'creator-one',
      }),
    ).resolves.toEqual({ kind: 'competition_not_found' });
  });

  it('rejects invalid and daylight-saving local times before persistence', async () => {
    const repository = new Repository();
    const service = new CompetitionSchedulingService(repository, new Permissions(true));
    for (const [localDateTime, kind] of [
      ['August 10', 'invalid_format'],
      ['2026-03-29 03:30', 'nonexistent_local_time'],
      ['2026-10-25 03:30', 'ambiguous_local_time'],
    ] as const) {
      await expect(
        service.schedule({
          competitionId: 'competition-one',
          guildId: 'guild-one',
          hasAdministratorPermission: true,
          localDateTime,
          memberRoleIds: [],
          requesterDiscordUserId: 'manager-one',
        }),
      ).resolves.toEqual({ kind });
    }
    expect(repository.request).toBeUndefined();
  });
});

class Permissions {
  public constructor(private readonly canManageCompetitions: boolean) {}
  public evaluate() {
    return Promise.resolve({ canManageCompetitions: this.canManageCompetitions });
  }
}

class Repository implements CompetitionSchedulingRepository {
  public request: { competitionId: string; guildId: string; intendedStartAt: Date } | undefined;
  public result: { createdByDiscordUserId: string; timezone: string } | 'not_found' | 'not_draft' =
    {
      createdByDiscordUserId: 'creator-one',
      timezone: 'Europe/Helsinki',
    };
  public findDraft() {
    return Promise.resolve(this.result);
  }
  public setIntendedStart(request: {
    competitionId: string;
    guildId: string;
    intendedStartAt: Date;
  }) {
    this.request = request;
    return Promise.resolve(true);
  }
}
