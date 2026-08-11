import { describe, expect, it, vi } from 'vitest';

import { DiscordCompetitionRolePublisher } from '../src/infrastructure/discord/competition-role-discord-publisher.js';

const operation = {
  attemptCount: 1,
  competitionId: 'competition-one',
  creatorDiscordUserId: 'creator-one',
  displayName: 'Winter grind',
  discordRoleId: null,
  guildId: 'guild-one',
  memberDiscordUserIds: ['member-one'],
  operation: 'create' as const,
};

describe('DiscordCompetitionRolePublisher', () => {
  it('adopts the deterministic role left by an interrupted create instead of creating another', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const existingRole = {
      id: 'role-one',
      members: new Map(),
      name: 'OSLeaders \u00B7 competition-one \u00B7 Winter grind',
    };
    const create = vi.fn();
    const publisher = new DiscordCompetitionRolePublisher({
      guilds: {
        fetch: vi.fn().mockResolvedValue({
          members: {
            fetch: vi.fn().mockResolvedValue({ roles: { add, cache: new Map() } }),
          },
          roles: {
            create,
            fetch: vi.fn().mockResolvedValue({
              find: (predicate: (role: typeof existingRole) => boolean) =>
                predicate(existingRole) ? existingRole : undefined,
            }),
          },
        }),
      },
    } as never);

    await expect(publisher.createAndAssign(operation)).resolves.toEqual({
      discordRoleId: 'role-one',
    });
    expect(create).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(existingRole);
  });

  it('removes departed members and assigns current draft entrants during synchronization', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const staleMember = { id: 'departed-member', roles: { remove } };
    const role = { id: 'role-one', members: new Map([['departed-member', staleMember]]) };
    const publisher = new DiscordCompetitionRolePublisher({
      guilds: {
        fetch: vi.fn().mockResolvedValue({
          members: {
            fetch: vi.fn().mockResolvedValue({ roles: { add, cache: new Map() } }),
          },
          roles: { fetch: vi.fn().mockResolvedValue(role) },
        }),
      },
    } as never);

    await publisher.syncAssignments({ ...operation, discordRoleId: 'role-one', operation: 'sync' });
    expect(remove).toHaveBeenCalledWith(role);
    expect(add).toHaveBeenCalledWith(role);
  });
});
