import { describe, expect, it } from 'vitest';

import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import {
  DailyRecapPreviewService,
  presentDailyRecap,
  type DailyRecapPreviewCollector,
} from '../src/features/recaps/daily-recap-presentation.js';
import type { DailyRecapCollectionResult } from '../src/features/recaps/daily-recap-collection.js';

describe('daily recap presentation', () => {
  it('groups changed linked accounts by member and keeps watchlists separate', () => {
    const presentation = presentDailyRecap(
      result([
        success(linkedAccount({ displayUsername: 'Second', id: 'second' }), {
          bosses: [{ boss: 'Zulrah', killCountGained: 4 }],
          skills: [],
        }),
        success(linkedAccount({ displayUsername: 'First', id: 'first' }), {
          bosses: [],
          skills: [{ currentLevel: 88, experienceGained: 100_000, levelGained: 1, skill: 'Magic' }],
        }),
        success(watchlistAccount(), {
          bosses: [],
          skills: [
            { currentLevel: 90, experienceGained: 500_000, levelGained: 3, skill: 'Crafting' },
          ],
        }),
        success(linkedAccount({ displayUsername: 'Unchanged', id: 'unchanged' }), {
          bosses: [],
          skills: [],
        }),
      ]),
    );

    expect(presentation).toMatchObject({
      failures: [],
      linkedMembers: [
        {
          accounts: [{ account: { id: 'second' } }, { account: { id: 'first' } }],
          discordUserId: 'member-one',
        },
      ],
      noActivity: false,
      watchlistAccounts: [{ account: { id: 'watchlist' } }],
    });
  });

  it('marks no activity and keeps failed accounts separate', () => {
    const presentation = presentDailyRecap(
      result([
        success(linkedAccount(), { bosses: [], skills: [] }),
        {
          account: linkedAccount({ displayUsername: 'Missing', id: 'missing' }),
          failure: { kind: 'not_found' },
          kind: 'failure',
        },
        {
          account: watchlistAccount({ displayUsername: 'Partial', id: 'partial' }),
          failure: { kind: 'baseline_incomplete', missing: ['skill:Attack'] },
          kind: 'failure',
        },
      ]),
    );

    expect(presentation).toMatchObject({
      failures: [
        { account: { id: 'missing' }, failure: { kind: 'not_found' } },
        { account: { id: 'partial' }, failure: { kind: 'baseline_incomplete' } },
      ],
      noActivity: true,
    });
  });

  it('collects a preview without any baseline-advancing or delivery dependency', async () => {
    const collector = new CollectorStub(result([]));
    const service = new DailyRecapPreviewService(collector);

    await expect(service.preview('guild-one')).resolves.toMatchObject({
      collection: { guildId: 'guild-one' },
      presentation: { noActivity: true },
    });
    expect(collector.guildIds).toEqual(['guild-one']);
    await expect(service.preview('guild-one')).resolves.not.toHaveProperty('content');
  });
});

class CollectorStub implements DailyRecapPreviewCollector {
  public readonly guildIds: string[] = [];

  public constructor(private readonly collection: DailyRecapCollectionResult) {}

  public collect(guildId: string): Promise<DailyRecapCollectionResult> {
    this.guildIds.push(guildId);
    return Promise.resolve({ ...this.collection, guildId });
  }
}

function result(outcomes: DailyRecapCollectionResult['outcomes']): DailyRecapCollectionResult {
  return {
    completedAt: new Date('2026-07-31T10:01:00.000Z'),
    guildId: 'guild-one',
    outcomes,
    startedAt: new Date('2026-07-31T10:00:00.000Z'),
  };
}

function success(
  account: TrackedAccount,
  changes: {
    bosses: { boss: string; killCountGained: number }[];
    skills: {
      currentLevel: number;
      experienceGained: number;
      levelGained: number;
      skill: string;
    }[];
  },
): DailyRecapCollectionResult['outcomes'][number] {
  return {
    account,
    candidateBaseline: {
      bossKillCounts: {},
      capturedAt: new Date('2026-07-31T10:00:00.000Z'),
      skillExperience: {},
      skillLevels: {},
    },
    changes,
    kind: 'success',
  };
}

function linkedAccount(overrides: Partial<TrackedAccount> = {}): TrackedAccount {
  return {
    accountMode: 'ironman',
    association: { discordUserId: 'member-one', type: 'linked' },
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    displayUsername: 'Linked',
    guildId: 'guild-one',
    id: 'linked',
    isDefault: true,
    normalizedUsername: 'linked',
    quotaOwnerDiscordUserId: 'member-one',
    registeredByDiscordUserId: 'member-one',
    ...overrides,
  };
}

function watchlistAccount(overrides: Partial<TrackedAccount> = {}): TrackedAccount {
  return {
    ...linkedAccount({
      accountMode: 'main',
      association: { type: 'watchlist' },
      displayUsername: 'Watchlisted',
      id: 'watchlist',
      isDefault: false,
      normalizedUsername: 'watchlisted',
    }),
    ...overrides,
  };
}
