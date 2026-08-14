import { describe, expect, it } from 'vitest';

import {
  MemberPresenceService,
  type GuildMemberPresence,
  type MemberPresenceRepository,
} from '../src/features/accounts/member-presence.js';

describe('member presence service', () => {
  it('records a member leaving and rejoining the same guild', async () => {
    const repository = new RecordingRepository();
    const service = new MemberPresenceService(repository);

    await expect(service.markAbsent('guild-one', 'member-one')).resolves.toMatchObject({
      isPresent: false,
    });
    await expect(service.markPresent('guild-one', 'member-one')).resolves.toMatchObject({
      isPresent: true,
    });
    await expect(service.get('guild-one', 'member-one')).resolves.toMatchObject({
      guildId: 'guild-one',
      discordUserId: 'member-one',
      isPresent: true,
    });
  });

  it('keeps member presence isolated by guild', async () => {
    const repository = new RecordingRepository();
    const service = new MemberPresenceService(repository);

    await service.markAbsent('guild-one', 'member-one');

    await expect(service.get('guild-two', 'member-one')).resolves.toBeUndefined();
  });

  it('reconciles a guild snapshot without changing another guild', async () => {
    const repository = new RecordingRepository();
    const service = new MemberPresenceService(repository);
    await service.markPresent('guild-one', 'departed-member');
    await service.markPresent('guild-two', 'other-guild-member');

    await service.reconcile('guild-one', ['current-member']);

    await expect(service.get('guild-one', 'departed-member')).resolves.toMatchObject({
      isPresent: false,
    });
    await expect(service.get('guild-one', 'current-member')).resolves.toMatchObject({
      isPresent: true,
    });
    await expect(service.get('guild-two', 'other-guild-member')).resolves.toMatchObject({
      isPresent: true,
    });
  });
});

class RecordingRepository implements MemberPresenceRepository {
  private readonly presences = new Map<string, GuildMemberPresence>();

  public getMemberPresence(guildId: string, discordUserId: string) {
    return Promise.resolve(this.presences.get(key(guildId, discordUserId)));
  }

  public markMemberAbsent(guildId: string, discordUserId: string) {
    return Promise.resolve(this.save(guildId, discordUserId, false));
  }

  public markMemberPresent(guildId: string, discordUserId: string) {
    return Promise.resolve(this.save(guildId, discordUserId, true));
  }

  public reconcileGuildMemberPresence(
    guildId: string,
    presentDiscordUserIds: readonly string[],
  ): Promise<void> {
    const currentMembers = new Set(presentDiscordUserIds);
    for (const presence of this.presences.values()) {
      if (presence.guildId === guildId && !currentMembers.has(presence.discordUserId)) {
        this.save(guildId, presence.discordUserId, false);
      }
    }
    for (const discordUserId of currentMembers) this.save(guildId, discordUserId, true);
    return Promise.resolve();
  }

  private save(guildId: string, discordUserId: string, isPresent: boolean): GuildMemberPresence {
    const presence = { discordUserId, guildId, isPresent, updatedAt: new Date() };
    this.presences.set(key(guildId, discordUserId), presence);
    return presence;
  }
}

function key(guildId: string, discordUserId: string): string {
  return `${guildId}:${discordUserId}`;
}
