import { describe, expect, it, vi } from 'vitest';

import { DiscordCompetitionStartAnnouncer } from '../src/infrastructure/discord/competition-start-discord-publisher.js';

const announcement = {
  competitionId: 'competition-one',
  displayName: 'Mining week',
  endsAt: new Date('2026-08-11T12:00:00.000Z'),
  guildId: 'guild-one',
  metric: { kind: 'skill' as const, name: 'Woodcutting' as const },
  startedAt: new Date('2026-08-10T12:00:00.000Z'),
};

describe('DiscordCompetitionStartAnnouncer', () => {
  it('posts immediately to the configured competition channel and mentions an already active role', async () => {
    const send = vi.fn(() => Promise.resolve({ id: 'message-one' }));
    const announcer = new DiscordCompetitionStartAnnouncer(
      {
        guilds: {
          fetch: vi.fn(() =>
            Promise.resolve({
              channels: { fetch: vi.fn(() => Promise.resolve(textChannel(send))) },
            }),
          ),
        },
      } as never,
      { findActiveRoleId: vi.fn(() => Promise.resolve('role-one')) },
    );

    await announcer.publish({ ...announcement, attemptCount: 1, channelId: 'channel-one' });

    expect(send).toHaveBeenCalledWith({
      allowedMentions: { roles: ['role-one'] },
      content:
        'Competition **Mining week** has started! Woodcutting XP. Ends <t:1786449600:R>.'.replace(
          'Competition',
          '<@&role-one> Competition',
        ),
    });
  });

  it('posts without a role mention when no active role is already available', async () => {
    const send = vi.fn(() => Promise.resolve({ id: 'message-one' }));
    const announcer = new DiscordCompetitionStartAnnouncer(
      {
        guilds: {
          fetch: vi.fn(() =>
            Promise.resolve({
              channels: { fetch: vi.fn(() => Promise.resolve(textChannel(send))) },
            }),
          ),
        },
      } as never,
      { findActiveRoleId: vi.fn(() => Promise.resolve(undefined)) },
    );

    await announcer.publish({
      ...announcement,
      attemptCount: 1,
      channelId: 'channel-one',
      endsAt: null,
      metric: { kind: 'boss', name: 'Zulrah' },
    });

    expect(send).toHaveBeenCalledWith({
      allowedMentions: { parse: [] },
      content: 'Competition **Mining week** has started! Zulrah KC. Target race with no deadline.',
    });
  });
});

function textChannel(send: ReturnType<typeof vi.fn>) {
  return { isSendable: () => true, isTextBased: () => true, send };
}
