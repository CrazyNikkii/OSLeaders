import { describe, expect, it } from 'vitest';

import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import {
  DailyRecapCollectionService,
  type DailyRecapCollectionHiscoreFetcher,
  type DailyRecapCollectionRepository,
  type RecapCollectionAccount,
} from '../src/features/recaps/daily-recap-collection.js';
import type { HiscoreParseResult } from '../src/infrastructure/hiscores/hiscore-result.js';
import {
  OSRS_BOSS_ACTIVITY_NAMES,
  OSRS_SKILL_NAMES,
  type OsrsHiscoreEndpoint,
} from '../src/infrastructure/hiscores/osrs-hiscore-catalog.js';

describe('daily recap collection service', () => {
  it('collects only guild accounts, bypasses the cache, calculates positive-only changes, and returns candidate baselines', async () => {
    const account = trackedAccount();
    const recap = recapAccount(account);
    recap.baseline.bossKillCounts['Maggot King'] = -1;
    const repository = new RepositoryStub([recap]);
    const hiscores = new HiscoreStub({
      'Rune Scape': success(
        { Attack: { experience: 150, level: 12 }, Defence: { experience: 90, level: 11 } },
        { 'Maggot King': 1, Zulrah: 15 },
      ),
    });
    const dates = [
      new Date('2026-07-31T10:00:00.000Z'),
      new Date('2026-07-31T10:01:00.000Z'),
      new Date('2026-07-31T10:02:00.000Z'),
    ];
    const service = new DailyRecapCollectionService(repository, hiscores, () => popDate(dates));

    await expect(service.collect('guild-one')).resolves.toMatchObject({
      completedAt: new Date('2026-07-31T10:02:00.000Z'),
      guildId: 'guild-one',
      outcomes: [
        {
          account: { id: 'account-one' },
          candidateBaseline: {
            bossKillCounts: { 'Maggot King': 1, Zulrah: 15 },
            capturedAt: new Date('2026-07-31T10:01:00.000Z'),
            skillExperience: { Attack: 150 },
            skillLevels: { Attack: 12 },
          },
          changes: {
            bosses: [
              { boss: 'Maggot King', killCountGained: 1 },
              { boss: 'Zulrah', killCountGained: 3 },
            ],
            skills: [
              { currentLevel: 12, experienceGained: 50, levelGained: 2, skill: 'Attack' },
              { currentLevel: 11, experienceGained: 0, levelGained: 1, skill: 'Defence' },
            ],
          },
          kind: 'success',
          previousBaselineCapturedAt: new Date('2026-07-30T10:00:00.000Z'),
        },
      ],
      startedAt: new Date('2026-07-31T10:00:00.000Z'),
    });
    expect(repository.guildRequests).toEqual(['guild-one']);
    expect(hiscores.requests).toEqual([
      {
        endpoint: 'hiscore_oldschool_ironman',
        options: { cacheMode: 'bypass' },
        username: 'Rune Scape',
      },
    ]);
  });

  it('preserves failed and incomplete accounts as failures while retaining successful outcomes', async () => {
    const available = recapAccount(
      trackedAccount({ displayUsername: 'Available', id: 'available' }),
    );
    const unavailable = recapAccount(
      trackedAccount({ displayUsername: 'Unavailable', id: 'unavailable' }),
    );
    const incomplete = recapAccount(
      trackedAccount({ displayUsername: 'Incomplete', id: 'incomplete' }),
    );
    const service = new DailyRecapCollectionService(
      new RepositoryStub([available, unavailable, incomplete]),
      new HiscoreStub({
        Available: success({ Attack: { experience: 101, level: 10 } }, {}),
        Incomplete: incompleteSuccess(),
        Unavailable: { kind: 'timeout' },
      }),
      () => new Date('2026-07-31T10:00:00.000Z'),
    );

    await expect(service.collect('guild-one')).resolves.toMatchObject({
      outcomes: [
        { account: { id: 'available' }, kind: 'success' },
        { account: { id: 'unavailable' }, failure: { kind: 'timeout' }, kind: 'failure' },
        {
          account: { id: 'incomplete' },
          failure: { kind: 'incomplete_response', missing: ['skill:Overall'] },
          kind: 'failure',
        },
      ],
    });
  });

  it('reports an incomplete baseline without fetching or producing a candidate replacement', async () => {
    const entry = recapAccount(trackedAccount());
    entry.baseline.skillExperience = {};
    const hiscores = new HiscoreStub({ 'Rune Scape': success({}, {}) });
    const service = new DailyRecapCollectionService(
      new RepositoryStub([entry]),
      hiscores,
      () => new Date('2026-07-31T10:00:00.000Z'),
    );

    const result = await service.collect('guild-one');
    const [outcome] = result.outcomes;
    expect(outcome?.kind).toBe('failure');
    if (outcome?.kind === 'failure' && outcome.failure.kind === 'baseline_incomplete') {
      expect(outcome.failure.missing).toContain('skillExperience:Overall');
    }
    expect(hiscores.requests).toEqual([]);
  });
});

class RepositoryStub implements DailyRecapCollectionRepository {
  public readonly guildRequests: string[] = [];

  public constructor(private readonly accounts: readonly RecapCollectionAccount[]) {}

  public listForGuild(guildId: string): Promise<readonly RecapCollectionAccount[]> {
    this.guildRequests.push(guildId);
    return Promise.resolve(this.accounts.filter((entry) => entry.account.guildId === guildId));
  }
}

class HiscoreStub implements DailyRecapCollectionHiscoreFetcher {
  public readonly requests: {
    endpoint: OsrsHiscoreEndpoint;
    options: { cacheMode: 'bypass' };
    username: string;
  }[] = [];

  public constructor(
    private readonly results: Readonly<
      Record<string, ReturnType<typeof success> | { kind: 'timeout' }>
    >,
  ) {}

  public fetchHiscores(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
    options: { cacheMode: 'bypass' },
  ): Promise<ReturnType<typeof success> | { kind: 'timeout' }> {
    this.requests.push({ endpoint, options, username });
    const result = this.results[username];
    if (result === undefined) {
      throw new Error(`No Hiscores result was configured for ${username}.`);
    }
    return Promise.resolve(result);
  }
}

function recapAccount(account: TrackedAccount): RecapCollectionAccount {
  return {
    account,
    baseline: {
      bossKillCounts: Object.fromEntries(OSRS_BOSS_ACTIVITY_NAMES.map((name) => [name, 12])),
      capturedAt: new Date('2026-07-30T10:00:00.000Z'),
      skillExperience: Object.fromEntries(OSRS_SKILL_NAMES.map((name) => [name, 100])),
      skillLevels: Object.fromEntries(OSRS_SKILL_NAMES.map((name) => [name, 10])),
    },
  };
}

function trackedAccount(overrides: Partial<TrackedAccount> = {}): TrackedAccount {
  return {
    accountMode: 'ironman',
    association: { discordUserId: 'member-one', type: 'linked' },
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    displayUsername: 'Rune Scape',
    guildId: 'guild-one',
    id: 'account-one',
    isDefault: true,
    normalizedUsername: 'rune scape',
    quotaOwnerDiscordUserId: 'member-one',
    registeredByDiscordUserId: 'member-one',
    ...overrides,
  };
}

function success(
  changedSkills: Partial<Record<string, { experience: number; level: number }>>,
  changedBosses: Partial<Record<string, number>>,
): Extract<HiscoreParseResult, { kind: 'success' }> {
  return {
    data: {
      activities: [],
      bosses: OSRS_BOSS_ACTIVITY_NAMES.map((name, id) => ({
        id,
        name,
        rank: 1,
        score: changedBosses[name] ?? 12,
      })),
      returnedName: 'Rune Scape',
      skills: OSRS_SKILL_NAMES.map((name, id) => ({
        experience: changedSkills[name]?.experience ?? 100,
        id,
        level: changedSkills[name]?.level ?? 10,
        name,
        rank: 1,
      })),
    },
    kind: 'success',
  };
}

function incompleteSuccess(): Extract<HiscoreParseResult, { kind: 'success' }> {
  const result = success({}, {});
  return { ...result, data: { ...result.data, skills: result.data.skills.slice(1) } };
}

function popDate(dates: Date[]): Date {
  const date = dates.shift();
  if (date === undefined) {
    throw new Error('No date was configured.');
  }
  return date;
}
