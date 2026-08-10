import { ActionRowBuilder, MessageFlags, StringSelectMenuBuilder } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

import type { TrackedAccount } from '../src/features/accounts/register-account.js';
import type { BossLeaderboardResult } from '../src/features/leaderboards/boss-leaderboard.js';
import {
  BossLeaderboardCommandHandler,
  DiscordBossLeaderboardCommandAdapter,
  bossLeaderboardCommandDefinitions,
  bossLeaderboardEmbeds,
} from '../src/infrastructure/discord/boss-leaderboard-command.js';
import type { OsrsBossActivityName } from '../src/infrastructure/hiscores/osrs-hiscore-catalog.js';

describe('Discord boss leaderboard command', () => {
  it('registers a guild-only command with result-scope choices and no truncated boss option', () => {
    const definition = bossLeaderboardCommandDefinitions[0];

    expect(definition).toMatchObject({
      description: 'Compare tracked OSRS accounts by boss kill count.',
      name: 'boss-leaderboard',
    });
    expect(JSON.stringify(definition)).not.toContain('"autocomplete":true');
    expect(JSON.stringify(definition)).toContain('"name":"Top 10","value":"top_10"');
    expect(JSON.stringify(definition)).toContain('"name":"All","value":"all"');
  });

  it('uses the shared bounded boss menus and acknowledges selection before fetching', async () => {
    const order: string[] = [];
    const services = new LeaderboardServices(resultWithEntries(12), () => order.push('fetch'));
    const adapter = new DiscordBossLeaderboardCommandAdapter(
      new BossLeaderboardCommandHandler(services),
    );
    const command = commandInteraction();

    await adapter.handle(command as never);

    const firstReply = command.reply.mock.calls[0]?.[0];
    if (firstReply === undefined) throw new Error('Expected boss menu response.');
    expect(
      firstReply.components.map((component) => component.toJSON().components[0]?.placeholder),
    ).toEqual(['Choose boss (A–D)', 'Choose boss (G–S)', 'Choose boss (S–Z)']);
    expect(firstReply.flags).toBe(MessageFlags.Ephemeral);
    const customId = firstReply.components[2]?.toJSON().components[0]?.custom_id;
    if (customId === undefined) throw new Error('Expected final boss selector.');
    const selection = selectInteraction(customId, 'Zulrah', order);

    await adapter.handle(selection as never);

    expect(order).toEqual(['defer', 'fetch', 'send', 'delete']);
    expect(services.requests).toEqual([{ boss: 'Zulrah', guildId: 'guild-one' }]);
    const response = JSON.stringify(selection.channel.send.mock.calls[0]);
    expect(response).toContain('10. **Account 10**');
    expect(response).not.toContain('11. **Account 11**');
  });

  it('retains the all-results choice through the boss selection session', async () => {
    const services = new LeaderboardServices(resultWithEntries(12));
    const adapter = new DiscordBossLeaderboardCommandAdapter(
      new BossLeaderboardCommandHandler(services),
    );
    const command = commandInteraction('all');
    await adapter.handle(command as never);
    const reply = command.reply.mock.calls[0]?.[0];
    if (reply === undefined) throw new Error('Expected boss menu response.');
    const customId = reply.components[0]?.toJSON().components[0]?.custom_id;
    if (customId === undefined) throw new Error('Expected boss selector.');

    const selection = selectInteraction(customId, 'Abyssal Sire');
    await adapter.handle(selection as never);

    const response = JSON.stringify(selection.channel.send.mock.calls[0]);
    expect(response).toContain('12. **Account 12**');
    expect(response).toContain('<@member-one>');
    expect(response).toContain('Watchlist');
    expect(response).toContain('Ironman');
  });

  it('rejects a forged boss value without fetching a leaderboard', async () => {
    const services = new LeaderboardServices(resultWithEntries(1));
    const handler = new BossLeaderboardCommandHandler(services);
    const selection = handler.start('guild-one', 'member-one', null);
    if (selection.kind !== 'boss_selection') throw new Error('Expected boss selection.');

    await expect(
      handler.selectBoss('guild-one', 'member-one', selection.customIds[0] ?? '', 'not a boss'),
    ).resolves.toMatchObject({ kind: 'invalid_boss' });
    expect(services.requests).toEqual([]);
  });

  it('rejects direct-message use before creating a selection', async () => {
    const services = new LeaderboardServices(resultWithEntries(1));
    const adapter = new DiscordBossLeaderboardCommandAdapter(
      new BossLeaderboardCommandHandler(services),
    );
    const command = commandInteraction(null, null);

    await adapter.handle(command as never);

    expect(command.reply).toHaveBeenCalledWith({
      content: 'This command can only be used in a Discord server.',
    });
    expect(services.requests).toEqual([]);
  });

  it('binds the selection to its guild and requester and rejects expired sessions', async () => {
    const clock = new FakeClock();
    const handler = new BossLeaderboardCommandHandler(
      new LeaderboardServices(resultWithEntries(1)),
      () => clock.now(),
    );
    const selection = handler.start('guild-one', 'member-one', null);
    if (selection.kind !== 'boss_selection') throw new Error('Expected boss selection.');
    const customId = selection.customIds[0];
    if (customId === undefined) throw new Error('Expected boss selector.');

    await expect(
      handler.selectBoss('guild-one', 'member-two', customId, 'Abyssal Sire'),
    ).resolves.toMatchObject({ kind: 'forbidden' });
    const expiring = handler.start('guild-one', 'member-one', null);
    if (expiring.kind !== 'boss_selection') throw new Error('Expected boss selection.');
    clock.advance(5 * 60 * 1_000);
    await expect(
      handler.selectBoss('guild-one', 'member-one', expiring.customIds[0] ?? '', 'Abyssal Sire'),
    ).resolves.toMatchObject({ kind: 'expired' });
  });

  it('renders unavailable accounts and splits oversized public leaderboard output', () => {
    const entries = Array.from({ length: 90 }, (_, index) => ({
      account: account({ displayUsername: `A very long account name ${index + 1}` }),
      boss: { id: 0, name: 'Abyssal Sire' as const, rank: index + 1, score: index + 1 },
    }));
    const embeds = bossLeaderboardEmbeds(
      {
        entries,
        failures: [
          { account: account({ displayUsername: 'Unavailable' }), failure: { kind: 'timeout' } },
        ],
        boss: 'Abyssal Sire',
      },
      undefined,
    );

    expect(embeds.length).toBeGreaterThan(1);
    expect(embeds.every((embed) => (embed.data.description?.length ?? 0) <= 4_096)).toBe(true);
    expect(JSON.stringify(embeds)).toContain('Unavailable accounts');
  });
});

class LeaderboardServices {
  public readonly requests: unknown[] = [];

  public constructor(
    private readonly result: BossLeaderboardResult,
    private readonly onRequest: () => void = () => undefined,
  ) {}

  public bossLeaderboard = {
    getLeaderboard: (request: unknown) => {
      this.onRequest();
      this.requests.push(request);
      return Promise.resolve({
        ...this.result,
        boss: (request as { boss: OsrsBossActivityName }).boss,
      });
    },
  };
}

class FakeClock {
  private current = new Date('2026-08-10T00:00:00.000Z');

  public now(): Date {
    return this.current;
  }

  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

function commandInteraction(results: string | null = null, guildId: string | null = 'guild-one') {
  return {
    commandName: 'boss-leaderboard',
    guildId,
    isChatInputCommand: () => true,
    options: { getString: () => results },
    reply: vi.fn<(result: BossSelectionResponse) => Promise<void>>(() => Promise.resolve()),
    user: { id: 'member-one' },
  };
}

interface BossSelectionResponse {
  components: ActionRowBuilder<StringSelectMenuBuilder>[];
  content: string;
  flags: MessageFlags;
}

function selectInteraction(customId: string, value: string, order?: string[]) {
  return {
    channel: {
      isSendable: () => true,
      send: vi.fn(() => {
        order?.push('send');
        return Promise.resolve();
      }),
    },
    customId,
    deferUpdate: vi.fn(() => {
      order?.push('defer');
      return Promise.resolve();
    }),
    editReply: vi.fn(() => {
      order?.push('edit');
      return Promise.resolve();
    }),
    deleteReply: vi.fn(() => {
      order?.push('delete');
      return Promise.resolve();
    }),
    guildId: 'guild-one',
    isChatInputCommand: () => false,
    isStringSelectMenu: () => true,
    user: { id: 'member-one' },
    values: [value],
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
