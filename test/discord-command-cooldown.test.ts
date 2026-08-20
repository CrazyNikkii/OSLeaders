import { describe, expect, it } from 'vitest';

import { InMemoryDiscordCommandCooldown } from '../src/infrastructure/discord/discord-command-cooldown.js';

describe('Discord command cooldown', () => {
  it('throttles a member for three seconds and allows the boundary instant', () => {
    let now = new Date('2026-08-20T10:00:00.000Z');
    const cooldown = new InMemoryDiscordCommandCooldown({ now: () => now });
    const request = { guildId: 'guild-one', requesterDiscordUserId: 'member-one' };

    expect(cooldown.tryAcquire(request)).toEqual({ kind: 'granted' });
    expect(cooldown.tryAcquire(request)).toEqual({ kind: 'cooling_down', retryAfterSeconds: 3 });

    now = new Date('2026-08-20T10:00:03.000Z');
    expect(cooldown.tryAcquire(request)).toEqual({ kind: 'granted' });
  });

  it('keeps Discord members isolated by both guild and user', () => {
    const cooldown = new InMemoryDiscordCommandCooldown({ now: () => new Date() });

    expect(
      cooldown.tryAcquire({ guildId: 'guild-one', requesterDiscordUserId: 'member-one' }),
    ).toEqual({
      kind: 'granted',
    });
    expect(
      cooldown.tryAcquire({ guildId: 'guild-one', requesterDiscordUserId: 'member-two' }),
    ).toEqual({
      kind: 'granted',
    });
    expect(
      cooldown.tryAcquire({ guildId: 'guild-two', requesterDiscordUserId: 'member-one' }),
    ).toEqual({
      kind: 'granted',
    });
  });
});
