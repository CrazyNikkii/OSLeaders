import { describe, expect, it, vi } from 'vitest';

import {
  competitionStartAnnouncementEmbed,
  DiscordCompetitionStartAnnouncer,
} from '../src/infrastructure/discord/competition-start-discord-publisher.js';
import { OSLEADERS_EMBED_COLOR } from '../src/infrastructure/discord/discord-embed-presentation.js';

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
      content: '<@&role-one>',
      embeds: [competitionStartAnnouncementEmbed(announcement)],
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
      embeds: [
        competitionStartAnnouncementEmbed({
          ...announcement,
          endsAt: null,
          metric: { kind: 'boss', name: 'Zulrah' },
        }),
      ],
    });
  });

  it('uses the standard OSLeaders embed presentation for the announcement', () => {
    expect(competitionStartAnnouncementEmbed(announcement).toJSON()).toEqual({
      color: OSLEADERS_EMBED_COLOR,
      description: '**Mining week**\n\n**Woodcutting XP** - Ends <t:1786449600:R>.',
      footer: { text: 'Competition announcement' },
      title: 'Competition started',
    });
  });
});

function textChannel(send: ReturnType<typeof vi.fn>) {
  return { isSendable: () => true, isTextBased: () => true, send };
}
