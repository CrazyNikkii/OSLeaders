import { describe, expect, it, vi } from 'vitest';

import {
  DiscordCompetitionStartFailureAuditPublisher,
  splitCompetitionStartFailureAuditContent,
} from '../src/infrastructure/discord/competition-start-failure-audit-publisher.js';

describe('Discord competition start failure audit publisher', () => {
  it('uses the configured guild administrative channel', async () => {
    const send = vi.fn(() => Promise.resolve());
    const fetchChannel = vi.fn(() =>
      Promise.resolve({ isSendable: () => true, isTextBased: () => true, send }),
    );
    const fetchGuild = vi.fn(() => Promise.resolve({ channels: { fetch: fetchChannel } }));
    const publisher = new DiscordCompetitionStartFailureAuditPublisher(
      { guilds: { fetch: fetchGuild } } as never,
      { getOrCreate: vi.fn(() => Promise.resolve(configurationValue())) },
    );

    await publisher.publish('guild-one', 'technical failure summary');

    expect(fetchGuild).toHaveBeenCalledWith('guild-one');
    expect(fetchChannel).toHaveBeenCalledWith('audit-channel');
    expect(send).toHaveBeenCalledWith({ content: 'technical failure summary' });
  });

  it('does not resolve Discord resources without a configured administrative channel', async () => {
    const fetchGuild = vi.fn();
    const publisher = new DiscordCompetitionStartFailureAuditPublisher(
      { guilds: { fetch: fetchGuild } } as never,
      {
        getOrCreate: vi.fn(() =>
          Promise.resolve(configurationValue({ administrativeLogChannelId: null })),
        ),
      },
    );

    await publisher.publish('guild-one', 'technical failure summary');
    expect(fetchGuild).not.toHaveBeenCalled();
  });

  it('splits oversized summaries into Discord-safe messages retaining the heading', () => {
    const heading = '**Competition start pending** (reference: err_competition_start)';
    const chunks = splitCompetitionStartFailureAuditContent(
      `${heading}\n${'- unavailable account: '.repeat(500)}`,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith(heading))).toBe(true);
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
