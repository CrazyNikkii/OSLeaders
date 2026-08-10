import { describe, expect, it } from 'vitest';

import {
  CompetitionCreationService,
  normalizeCompetitionName,
  type CompetitionCreationRepository,
  type CompetitionDraft,
  type CreateCompetitionRequest,
} from '../src/features/competitions/create-competition.js';

describe('competition creation service', () => {
  it('creates each approved competition type as a guild-scoped draft', async () => {
    const repository = new CompetitionRepository();
    const service = new CompetitionCreationService(
      repository,
      { evaluate: () => Promise.resolve({ canManageCompetitions: true }) },
      () => 'competition-one',
      () => new Date('2026-08-07T12:00:00.000Z'),
    );

    await expect(
      service.create(
        request({
          type: 'most_skill_xp',
          metric: { kind: 'skill', name: 'Woodcutting' },
          durationSeconds: 172800,
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'created',
      competition: {
        durationSeconds: 172800,
        metric: { kind: 'skill', name: 'Woodcutting' },
        normalizedName: 'weekend woodcutting',
        state: 'draft',
        targetValue: null,
      },
    });
    await expect(
      service.create(
        request({
          type: 'skill_xp_target_race',
          metric: { kind: 'skill', name: 'Mining' },
          targetValue: 1000000n,
          name: 'Mining race',
        }),
      ),
    ).resolves.toMatchObject({ kind: 'created', competition: { targetValue: 1000000n } });
    await expect(
      service.create(
        request({
          type: 'most_boss_kc',
          metric: { kind: 'boss', name: 'Zulrah' },
          durationSeconds: 3600,
          name: 'Zulrah hour',
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'created',
      competition: { metric: { kind: 'boss', name: 'Zulrah' } },
    });
    await expect(
      service.create(
        request({
          type: 'boss_kc_target_race',
          metric: { kind: 'boss', name: 'Vorkath' },
          targetValue: 50n,
          name: 'Vorkath race',
        }),
      ),
    ).resolves.toMatchObject({ kind: 'created', competition: { targetValue: 50n } });
  });

  it('rejects unauthorized, incomplete, invalid, and non-positive competition definitions', async () => {
    const repository = new CompetitionRepository();
    const forbidden = new CompetitionCreationService(
      repository,
      { evaluate: () => Promise.resolve({ canManageCompetitions: false }) },
      () => 'competition-one',
    );
    const allowed = new CompetitionCreationService(
      repository,
      { evaluate: () => Promise.resolve({ canManageCompetitions: true }) },
      () => 'competition-one',
    );

    await expect(forbidden.create(request())).resolves.toEqual({ kind: 'forbidden' });
    await expect(allowed.create(request({ name: '   ' }))).resolves.toEqual({
      kind: 'invalid_definition',
    });
    await expect(
      allowed.create(
        request({
          type: 'most_skill_xp',
          metric: { kind: 'skill', name: 'Mining' },
          durationSeconds: 0,
        }),
      ),
    ).resolves.toEqual({ kind: 'invalid_definition' });
    await expect(
      allowed.create(
        request({
          type: 'boss_kc_target_race',
          metric: { kind: 'boss', name: 'Zulrah' },
          targetValue: 0n,
        }),
      ),
    ).resolves.toEqual({ kind: 'invalid_definition' });
    await expect(
      allowed.create(
        request({
          metric: { kind: 'skill', name: 'Not a Skill' },
          name: 'Invalid skill',
        }),
      ),
    ).resolves.toEqual({ kind: 'invalid_definition' });
    await expect(
      allowed.create(
        request({
          metric: { kind: 'boss', name: 'Anything' },
          name: 'Invalid boss',
          type: 'most_boss_kc',
        }),
      ),
    ).resolves.toEqual({ kind: 'invalid_definition' });
    await expect(
      allowed.create(request({ name: 'Invalid timezone', timezone: 'Not/A_Timezone' })),
    ).resolves.toEqual({ kind: 'invalid_definition' });
    await expect(
      allowed.create(
        request({
          durationSeconds: 2_147_483_648,
          name: 'Duration too large',
        }),
      ),
    ).resolves.toEqual({ kind: 'invalid_definition' });
    await expect(
      allowed.create(
        request({
          metric: { kind: 'boss', name: 'Zulrah' },
          name: 'Target too large',
          targetValue: 9_223_372_036_854_775_808n,
          type: 'boss_kc_target_race',
        }),
      ),
    ).resolves.toEqual({ kind: 'invalid_definition' });
    expect(repository.competitions).toEqual([]);
  });

  it('retains a valid intended UTC start instant and rejects an invalid one', async () => {
    const repository = new CompetitionRepository();
    const service = new CompetitionCreationService(
      repository,
      { evaluate: () => Promise.resolve({ canManageCompetitions: true }) },
      () => 'competition-one',
    );
    const intendedStartAt = new Date('2026-08-10T12:30:00.000Z');

    await expect(service.create(request({ intendedStartAt }))).resolves.toMatchObject({
      kind: 'created',
      competition: { intendedStartAt },
    });
    await expect(
      service.create(request({ intendedStartAt: new Date('invalid') })),
    ).resolves.toEqual({
      kind: 'invalid_definition',
    });
  });

  it('accepts values at the PostgreSQL integer and bigint limits', async () => {
    const repository = new CompetitionRepository();
    const service = new CompetitionCreationService(
      repository,
      { evaluate: () => Promise.resolve({ canManageCompetitions: true }) },
      () => `competition-${repository.competitions.length + 1}`,
    );

    await expect(
      service.create(request({ durationSeconds: 2_147_483_647, name: 'Maximum duration' })),
    ).resolves.toMatchObject({ kind: 'created' });
    await expect(
      service.create(
        request({
          metric: { kind: 'boss', name: 'Zulrah' },
          name: 'Maximum target',
          targetValue: 9_223_372_036_854_775_807n,
          type: 'boss_kc_target_race',
        }),
      ),
    ).resolves.toMatchObject({ kind: 'created' });
  });

  it('keeps name uniqueness within a guild while allowing the same name elsewhere', async () => {
    const repository = new CompetitionRepository();
    const service = new CompetitionCreationService(
      repository,
      { evaluate: () => Promise.resolve({ canManageCompetitions: true }) },
      () => `competition-${repository.competitions.length + 1}`,
    );

    await expect(service.create(request())).resolves.toMatchObject({ kind: 'created' });
    await expect(service.create(request({ name: ' weekend   woodcutting ' }))).resolves.toEqual({
      kind: 'name_taken',
    });
    await expect(service.create(request({ guildId: 'guild-two' }))).resolves.toMatchObject({
      kind: 'created',
    });
  });

  it('normalizes display spacing without changing the readable name', () => {
    expect(normalizeCompetitionName('  Weekend\tWoodcutting  ')).toEqual({
      displayName: 'Weekend Woodcutting',
      normalizedName: 'weekend woodcutting',
    });
  });
});

class CompetitionRepository implements CompetitionCreationRepository {
  public readonly competitions: CompetitionDraft[] = [];

  public create(draft: CompetitionDraft) {
    if (
      this.competitions.some(
        (competition) =>
          competition.guildId === draft.guildId &&
          competition.normalizedName === draft.normalizedName,
      )
    ) {
      return Promise.resolve({ kind: 'name_taken' as const });
    }
    this.competitions.push(draft);
    return Promise.resolve({ kind: 'created' as const, competition: draft });
  }
}

function request(overrides: Partial<CreateCompetitionRequest> = {}): CreateCompetitionRequest {
  return {
    createdByDiscordUserId: 'manager-one',
    durationSeconds: 86400,
    guildId: 'guild-one',
    hasAdministratorPermission: false,
    memberRoleIds: ['competition-manager'],
    metric: { kind: 'skill', name: 'Woodcutting' },
    name: 'Weekend Woodcutting',
    timezone: 'Europe/Helsinki',
    type: 'most_skill_xp',
    ...overrides,
  } as CreateCompetitionRequest;
}
