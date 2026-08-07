import { describe, expect, it, vi } from 'vitest';

import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import type { SkillLeaderboardResult } from '../src/features/leaderboards/skill-leaderboard.js';
import {
  DiscordSkillLeaderboardCommandAdapter,
  SkillLeaderboardCommandHandler,
  skillLeaderboardCommandDefinitions,
  skillLeaderboardEmbeds,
} from '../src/infrastructure/discord/skill-leaderboard-command.js';

describe('Discord skill leaderboard command', () => {
  it('registers a guild-only command with canonical skill and result-scope choices', () => {
    const definition = skillLeaderboardCommandDefinitions[0];

    expect(definition).toMatchObject({
      description: 'Compare tracked OSRS accounts by skill experience.',
      name: 'skill-leaderboard',
    });
    expect(JSON.stringify(definition)).toContain('"name":"Strength","value":"Strength"');
    expect(JSON.stringify(definition)).toContain('"name":"Top 10","value":"top_10"');
    expect(JSON.stringify(definition)).toContain('"name":"All","value":"all"');
  });

  it('uses only the interaction guild and shows the top ten by default', async () => {
    const services = new LeaderboardServices(resultWithEntries(12));
    const adapter = new DiscordSkillLeaderboardCommandAdapter(
      new SkillLeaderboardCommandHandler(services),
    );
    const responses = responseInteractions();

    await adapter.handle(interaction(responses) as never);

    expect(services.requests).toEqual([{ guildId: 'guild-one', skill: 'Strength' }]);
    expect(responses.deferReply).toHaveBeenCalledOnce();
    const response = JSON.stringify(responses.editReply.mock.calls[0]);
    expect(response).toContain('1. **Account 1**');
    expect(response).toContain('10. **Account 10**');
    expect(response).not.toContain('11. **Account 11**');
    expect(response).toContain('"color":14261046');
    expect(response).toContain('10 ranked accounts');
  });

  it('shows all results when requested and marks linked and watchlist accounts', async () => {
    const services = new LeaderboardServices(resultWithEntries(12));
    const adapter = new DiscordSkillLeaderboardCommandAdapter(
      new SkillLeaderboardCommandHandler(services),
    );
    const responses = responseInteractions();

    await adapter.handle(interaction(responses, 'all') as never);

    const response = JSON.stringify(responses.editReply.mock.calls[0]);
    expect(response).toContain('12. **Account 12**');
    expect(response).toContain('<@member-one>');
    expect(response).toContain('Watchlist');
    expect(response).toContain('Ironman');
  });

  it('reports unavailable accounts separately without hiding successful rankings', async () => {
    const result = resultWithEntries(1);
    const services = new LeaderboardServices({
      ...result,
      failures: [
        { account: account({ displayUsername: 'Unavailable' }), failure: { kind: 'timeout' } },
      ],
    });
    const adapter = new DiscordSkillLeaderboardCommandAdapter(
      new SkillLeaderboardCommandHandler(services),
    );
    const responses = responseInteractions();

    await adapter.handle(interaction(responses) as never);

    const response = JSON.stringify(responses.editReply.mock.calls[0]);
    expect(response).toContain('Account 1');
    expect(response).toContain('Unavailable accounts');
    expect(response).toContain('Unavailable');
    expect(response).toContain('Hiscores timed out');
  });

  it('keeps all leaderboard output within numbered embed pages', () => {
    const entries = Array.from({ length: 90 }, (_, index) => ({
      account: account({ displayUsername: `A very long account name ${index + 1}` }),
      skill: {
        experience: index + 1,
        id: 2,
        level: 99,
        name: 'Strength' as const,
        rank: index + 1,
      },
    }));

    const embeds = skillLeaderboardEmbeds({ entries, failures: [], skill: 'Strength' }, undefined);

    expect(embeds.length).toBeGreaterThan(1);
    expect(embeds.every((embed) => (embed.data.description?.length ?? 0) <= 4_096)).toBe(true);
    expect(embeds[0]?.data.title).toContain('(1/');
  });

  it('rejects direct-message use before calling the leaderboard service', async () => {
    const services = new LeaderboardServices(resultWithEntries(1));
    const adapter = new DiscordSkillLeaderboardCommandAdapter(
      new SkillLeaderboardCommandHandler(services),
    );
    const responses = responseInteractions();

    await adapter.handle(interaction(responses, null, null) as never);

    expect(services.requests).toEqual([]);
    expect(responses.deferReply).not.toHaveBeenCalled();
    expect(responses.reply).toHaveBeenCalledWith({
      content: 'This command can only be used in a Discord server.',
    });
  });
});

class LeaderboardServices {
  public readonly requests: unknown[] = [];

  public constructor(private readonly result: SkillLeaderboardResult) {}

  public skillLeaderboard = {
    getLeaderboard: (request: unknown) => {
      this.requests.push(request);
      return Promise.resolve(this.result);
    },
  };
}

function interaction(
  responses: ReturnType<typeof responseInteractions>,
  results: string | null = null,
  guildId: string | null = 'guild-one',
) {
  return {
    commandName: 'skill-leaderboard',
    guildId,
    isChatInputCommand: () => true,
    options: {
      getString: (name: string) => {
        if (name === 'skill') {
          return 'Strength';
        }
        return results;
      },
    },
    ...responses,
  };
}

function responseInteractions() {
  return {
    deferReply: vi.fn(() => Promise.resolve()),
    editReply: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
    reply: vi.fn(() => Promise.resolve()),
  };
}

function resultWithEntries(count: number): SkillLeaderboardResult {
  return {
    entries: Array.from({ length: count }, (_, index) => ({
      account: account({
        association:
          index % 2 === 0 ? { discordUserId: 'member-one', type: 'linked' } : { type: 'watchlist' },
        displayUsername: `Account ${index + 1}`,
      }),
      skill: {
        experience: 1_000 - index,
        id: 2,
        level: 99,
        name: 'Strength' as const,
        rank: index + 1,
      },
    })),
    failures: [],
    skill: 'Strength',
  };
}

function account(overrides: Partial<TrackedAccount> = {}): TrackedAccount {
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
