import { describe, expect, it, vi } from 'vitest';

import { initializeDiscordGuildMemberPresence } from '../src/infrastructure/discord/member-presence-initialization.js';

describe('Discord guild member presence initialization', () => {
  it('marks every current member of only the configured guild present', async () => {
    const reconcileSnapshot = vi.fn(
      async (_guildId: string, loadPresentDiscordUserIds: () => Promise<readonly string[]>) => {
        await loadPresentDiscordUserIds();
      },
    );
    const fetchMembers = vi.fn(() =>
      Promise.resolve(
        new Map([
          ['one', { user: { id: 'member-one' } }],
          ['two', { user: { id: 'member-two' } }],
        ]),
      ),
    );
    const fetchGuild = vi.fn(() => Promise.resolve({ members: { fetch: fetchMembers } }));

    await initializeDiscordGuildMemberPresence(
      { guilds: { fetch: fetchGuild } } as never,
      { reconcileSnapshot },
      'guild-one',
    );

    expect(fetchGuild).toHaveBeenCalledWith('guild-one');
    expect(reconcileSnapshot).toHaveBeenCalledWith('guild-one', expect.any(Function));
  });

  it('does not mask a Discord member-fetch failure', async () => {
    const failure = new Error('Discord unavailable');

    await expect(
      initializeDiscordGuildMemberPresence(
        {
          guilds: {
            fetch: vi.fn(() =>
              Promise.resolve({ members: { fetch: () => Promise.reject(failure) } }),
            ),
          },
        } as never,
        {
          reconcileSnapshot: vi.fn(
            async (
              _guildId: string,
              loadPresentDiscordUserIds: () => Promise<readonly string[]>,
            ) => {
              await loadPresentDiscordUserIds();
            },
          ),
        },
        'guild-one',
      ),
    ).rejects.toThrow(failure);
  });
});
