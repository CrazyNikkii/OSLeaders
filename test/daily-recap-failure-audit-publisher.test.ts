import { describe, expect, it, vi } from 'vitest';

import {
  DiscordDailyRecapFailureAuditPublisher,
  splitDailyRecapFailureAuditContent,
} from '../src/infrastructure/discord/daily-recap-failure-audit-publisher.js';

describe('Discord daily recap failure audit publisher', () => {
  it('uses the configured guild administrative channel for recap failure summaries', async () => {
    const send = vi.fn(() => Promise.resolve());
    const fetchChannel = vi.fn(() =>
      Promise.resolve({ isSendable: () => true, isTextBased: () => true, send }),
    );
    const fetchGuild = vi.fn(() => Promise.resolve({ channels: { fetch: fetchChannel } }));
    const configuration = { getOrCreate: vi.fn(() => Promise.resolve(configurationValue())) };
    const publisher = new DiscordDailyRecapFailureAuditPublisher(
      { guilds: { fetch: fetchGuild } } as never,
      configuration,
    );

    await publisher.publish('guild-one', 'technical failure summary');

    expect(fetchGuild).toHaveBeenCalledWith('guild-one');
    expect(fetchChannel).toHaveBeenCalledWith('audit-channel');
    expect(send).toHaveBeenCalledWith({ content: 'technical failure summary' });
  });

  it('does not resolve Discord resources when no administrative channel is configured', async () => {
    const fetchGuild = vi.fn();
    const publisher = new DiscordDailyRecapFailureAuditPublisher(
      { guilds: { fetch: fetchGuild } } as never,
      {
        getOrCreate: vi.fn(() =>
          Promise.resolve(configurationValue({ administrativeLogChannelId: null })),
        ),
      },
    );

    await expect(
      publisher.publish('guild-one', 'technical failure summary'),
    ).resolves.toBeUndefined();
    expect(fetchGuild).not.toHaveBeenCalled();
  });

  it('rejects an unavailable configured administrative channel', async () => {
    const publisher = new DiscordDailyRecapFailureAuditPublisher(
      {
        guilds: {
          fetch: vi.fn(() =>
            Promise.resolve({
              channels: { fetch: vi.fn(() => Promise.resolve(null)) },
            }),
          ),
        },
      } as never,
      { getOrCreate: vi.fn(() => Promise.resolve(configurationValue())) },
    );

    await expect(publisher.publish('guild-one', 'technical failure summary')).rejects.toThrow(
      'configured administrative log channel is not available',
    );
  });

  it('splits oversized summaries into Discord-safe messages retaining the heading and reference', async () => {
    const sentContents: string[] = [];
    const send = vi.fn((request: { content: string }) => {
      sentContents.push(request.content);
      return Promise.resolve();
    });
    const publisher = new DiscordDailyRecapFailureAuditPublisher(
      {
        guilds: {
          fetch: vi.fn(() =>
            Promise.resolve({
              channels: {
                fetch: vi.fn(() =>
                  Promise.resolve({ isSendable: () => true, isTextBased: () => true, send }),
                ),
              },
            }),
          ),
        },
      } as never,
      { getOrCreate: vi.fn(() => Promise.resolve(configurationValue())) },
    );
    const content = `**Daily recap account-fetch failures** (reference: err_recap_failure)\n${'- missing: '.repeat(500)}`;

    await publisher.publish('guild-one', content);

    const chunks = sentContents;
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(
      chunks.every((chunk) => chunk.startsWith('**Daily recap account-fetch failures**')),
    ).toBe(true);
    expect(
      chunks
        .map((chunk) =>
          chunk.replace(
            '**Daily recap account-fetch failures** (reference: err_recap_failure)\n',
            '',
          ),
        )
        .join(''),
    ).toBe('- missing: '.repeat(500));
  });

  it('splits at line boundaries before splitting an individual oversized account failure', () => {
    const heading = '**Daily recap account-fetch failures** (reference: err_recap_failure)';
    const chunks = splitDailyRecapFailureAuditContent(
      `${heading}\n- account one\n${'- missing: '.repeat(500)}\n- account two`,
    );

    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks[0]).toContain('- account one');
    expect(chunks.at(-1)).toContain('- account two');
  });
});

function configurationValue(overrides: { administrativeLogChannelId?: string | null } = {}) {
  return {
    administrativeLogChannelId: 'audit-channel',
    administrativeLogMode: 'standard' as const,
    botManagerRoleId: null,
    competitionManagerRoleId: null,
    guildId: 'guild-one',
    modeEmojis: {},
    recapChannelId: null,
    recapEnabled: false,
    recapLocalTime: null,
    timezone: 'UTC',
    ...overrides,
  };
}
