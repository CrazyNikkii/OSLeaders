import { describe, expect, it, vi } from 'vitest';
import type { EmbedBuilder } from 'discord.js';

import {
  dailyRecapDeliveryEmbeds,
  DiscordDailyRecapPublisher,
  splitDailyRecapContent,
} from '../src/infrastructure/discord/daily-recap-discord-publisher.js';

describe('Discord daily recap publisher', () => {
  it('resolves the stored channel through the delivery guild before posting the durable content', async () => {
    const send = vi.fn<(payload: { embeds: readonly EmbedBuilder[] }) => Promise<{ id: string }>>(
      () => Promise.resolve({ id: 'message-one' }),
    );
    const fetchChannel = vi.fn(() =>
      Promise.resolve({ isSendable: () => true, isTextBased: () => true, send }),
    );
    const fetchGuild = vi.fn(() => Promise.resolve({ channels: { fetch: fetchChannel } }));
    const publisher = new DiscordDailyRecapPublisher({ guilds: { fetch: fetchGuild } } as never);

    await expect(
      publisher.publish({
        attemptCount: 1,
        channelId: 'channel-one',
        content: '**<@member-one>**\n**Rune Scape · Main**',
        guildId: 'guild-one',
        recapRunId: 'run-one',
      }),
    ).resolves.toEqual({ discordMessageId: 'message-one' });
    expect(fetchGuild).toHaveBeenCalledWith('guild-one');
    expect(fetchChannel).toHaveBeenCalledWith('channel-one');
    const sent = send.mock.calls[0]?.[0];
    expect(sent?.embeds).toHaveLength(1);
    expect(sent?.embeds[0]?.data).toMatchObject({
      description: '**<@member-one>**\n**Rune Scape · Main**',
      footer: { text: 'Showing XP gains of 10,000+ · Recap run-one' },
      title: 'Daily recap',
    });
  });

  it('rejects an unavailable or non-sendable stored channel without posting', async () => {
    const fetchChannel = vi.fn(() =>
      Promise.resolve({ isSendable: () => false, isTextBased: () => true }),
    );
    const publisher = new DiscordDailyRecapPublisher({
      guilds: { fetch: vi.fn(() => Promise.resolve({ channels: { fetch: fetchChannel } })) },
    } as never);

    await expect(
      publisher.publish({
        attemptCount: 1,
        channelId: 'channel-one',
        content: '# Daily recap',
        guildId: 'guild-one',
        recapRunId: 'run-one',
      }),
    ).rejects.toThrow('configured daily recap channel is not available');
  });

  it('splits long valid recap content into bounded embed descriptions without visible delivery metadata', () => {
    const content = `${'A'.repeat(2_500)}\n${'B'.repeat(2_500)}`;

    const chunks = splitDailyRecapContent(content);
    const embeds = dailyRecapDeliveryEmbeds(content, 2, 'abcdefgh-1234');

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4_000)).toBe(true);
    expect(chunks.join('')).toBe(content.replaceAll('\n', ''));
    expect(embeds.map((embed) => embed.data.title)).toEqual([
      'Daily recap (1/2)',
      'Daily recap (2/2)',
    ]);
    expect(JSON.stringify(embeds)).toContain('Recap abcdefgh');
    expect(JSON.stringify(embeds)).toContain('Retry 2');
  });
});
