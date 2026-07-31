import { describe, expect, it, vi } from 'vitest';

import {
  DiscordDailyRecapPublisher,
  splitDailyRecapContent,
} from '../src/infrastructure/discord/daily-recap-discord-publisher.js';

describe('Discord daily recap publisher', () => {
  it('resolves the stored channel through the delivery guild before posting the durable content', async () => {
    const send = vi.fn(() => Promise.resolve({ id: 'message-one' }));
    const fetchChannel = vi.fn(() =>
      Promise.resolve({ isSendable: () => true, isTextBased: () => true, send }),
    );
    const fetchGuild = vi.fn(() => Promise.resolve({ channels: { fetch: fetchChannel } }));
    const publisher = new DiscordDailyRecapPublisher({ guilds: { fetch: fetchGuild } } as never);

    await expect(
      publisher.publish({
        attemptCount: 1,
        channelId: 'channel-one',
        content: '# Daily recap',
        guildId: 'guild-one',
        recapRunId: 'run-one',
      }),
    ).resolves.toEqual({ discordMessageId: 'message-one' });
    expect(fetchGuild).toHaveBeenCalledWith('guild-one');
    expect(fetchChannel).toHaveBeenCalledWith('channel-one');
    expect(send).toHaveBeenCalledWith({ content: '# Daily recap' });
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

  it('splits long valid recap content into numbered Discord-safe messages without omitting text', () => {
    const content = `# Daily recap\n${'A'.repeat(2_500)}\n${'B'.repeat(2_500)}`;

    const chunks = splitDailyRecapContent(content, 2);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.join('').replaceAll(/\*\*Daily recap - part \d\/\d+, retry 2\*\*\n/g, '')).toBe(
      content.replaceAll('\n', ''),
    );
  });
});
