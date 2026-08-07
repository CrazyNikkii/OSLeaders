import { MessageFlags } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import type { BossLeaderboardResult } from '../src/features/leaderboards/boss-leaderboard.js';
import {
  BossLeaderboardCommandHandler,
  DiscordBossLeaderboardCommandAdapter,
  bossLeaderboardCommandDefinitions,
  bossLeaderboardEmbeds,
} from '../src/infrastructure/discord/boss-leaderboard-command.js';

describe('Discord boss leaderboard command', () => {
  it('registers a guild-only command with canonical boss autocomplete and result-scope choices', () => {
    const definition = bossLeaderboardCommandDefinitions[0];

    expect(definition).toMatchObject({
      description: 'Compare tracked OSRS accounts by boss kill count.',
      name: 'boss-leaderboard',
    });
    expect(JSON.stringify(definition)).toContain('"autocomplete":true');
    expect(JSON.stringify(definition)).toContain('"name":"Top 10","value":"top_10"');
    expect(JSON.stringify(definition)).toContain('"name":"All","value":"all"');
  });

  it('suggests matching canonical boss names through autocomplete', async () => {
    const services = new LeaderboardServices(resultWithEntries(1));
    const adapter = new DiscordBossLeaderboardCommandAdapter(
      new BossLeaderboardCommandHandler(services),
    );
    const responses = responseInteractions();

    await adapter.handle(autocompleteInteraction(responses, 'sire') as never);

    expect(responses.respond).toHaveBeenCalledWith([
      { name: 'Abyssal Sire', value: 'Abyssal Sire' },
    ]);
    expect(services.requests).toEqual([]);
  });

  it('uses only the interaction guild and shows the top ten by default', async () => {
    const services = new LeaderboardServices(resultWithEntries(12));
    const adapter = new DiscordBossLeaderboardCommandAdapter(
      new BossLeaderboardCommandHandler(services),
    );
    const responses = responseInteractions();

    await adapter.handle(interaction(responses) as never);

    expect(services.requests).toEqual([{ boss: 'Abyssal Sire', guildId: 'guild-one' }]);
    expect(responses.deferReply).toHaveBeenCalledOnce();
    const response = JSON.stringify(responses.editReply.mock.calls[0]);
    expect(response).toContain('1. **Account 1**');
    expect(response).toContain('10. **Account 10**');
    expect(response).not.toContain('11. **Account 11**');
    expect(response).toContain('"color":14261046');
    expect(response).toContain('10 ranked accounts');
  });

  it('rejects a boss outside the canonical catalog before calling the leaderboard service', async () => {
    const services = new LeaderboardServices(resultWithEntries(1));
    const adapter = new DiscordBossLeaderboardCommandAdapter(
      new BossLeaderboardCommandHandler(services),
    );
    const responses = responseInteractions();

    await adapter.handle(interaction(responses, null, 'guild-one', 'not a boss') as never);

    expect(services.requests).toEqual([]);
    expect(responses.deferReply).not.toHaveBeenCalled();
    expect(responses.reply).toHaveBeenCalledWith({
      content: 'Choose a boss from the autocomplete suggestions.',
      flags: MessageFlags.Ephemeral,
    });
  });

  it('shows all results when requested and marks linked and watchlist accounts', async () => {
    const services = new LeaderboardServices(resultWithEntries(12));
    const adapter = new DiscordBossLeaderboardCommandAdapter(
      new BossLeaderboardCommandHandler(services),
    );
    const responses = responseInteractions();

    await adapter.handle(interaction(responses, 'all') as never);

    const response = JSON.stringify(responses.editReply.mock.calls[0]);
    expect(response).toContain('12. **Account 12**');
    expect(response).toContain('KC');
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
    const adapter = new DiscordBossLeaderboardCommandAdapter(
      new BossLeaderboardCommandHandler(services),
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
      boss: { id: 0, name: 'Abyssal Sire' as const, rank: index + 1, score: index + 1 },
    }));

    const embeds = bossLeaderboardEmbeds(
      { entries, failures: [], boss: 'Abyssal Sire' },
      undefined,
    );

    expect(embeds.length).toBeGreaterThan(1);
    expect(embeds.every((embed) => (embed.data.description?.length ?? 0) <= 4_096)).toBe(true);
    expect(embeds[0]?.data.title).toContain('(1/');
  });

  it('rejects direct-message use before calling the leaderboard service', async () => {
    const services = new LeaderboardServices(resultWithEntries(1));
    const adapter = new DiscordBossLeaderboardCommandAdapter(
      new BossLeaderboardCommandHandler(services),
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

  public constructor(private readonly result: BossLeaderboardResult) {}

  public bossLeaderboard = {
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
  boss = 'Abyssal Sire',
) {
  return {
    commandName: 'boss-leaderboard',
    guildId,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    options: {
      getString: (name: string) => {
        if (name === 'boss') {
          return boss;
        }
        return results;
      },
    },
    ...responses,
  };
}

function autocompleteInteraction(
  responses: ReturnType<typeof responseInteractions>,
  query: string,
) {
  return {
    commandName: 'boss-leaderboard',
    isAutocomplete: () => true,
    options: {
      getFocused: (required?: boolean) => (required ? { name: 'boss', value: query } : query),
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
    respond: vi.fn(() => Promise.resolve()),
  };
}

function resultWithEntries(count: number): BossLeaderboardResult {
  return {
    entries: Array.from({ length: count }, (_, index) => ({
      account: account({
        association:
          index % 2 === 0 ? { discordUserId: 'member-one', type: 'linked' } : { type: 'watchlist' },
        displayUsername: `Account ${index + 1}`,
      }),
      boss: { id: 0, name: 'Abyssal Sire' as const, rank: index + 1, score: 1_000 - index },
    })),
    boss: 'Abyssal Sire',
    failures: [],
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
