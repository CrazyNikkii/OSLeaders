import type { Client, Guild, GuildMember, Role } from 'discord.js';

import type {
  CompetitionRolePublisher,
  PendingCompetitionRoleOperation,
} from '../../features/competitions/manage-competition-role.js';
import {
  CompetitionRolePermissionError,
  MissingCompetitionRoleError,
} from '../../features/competitions/manage-competition-role.js';

export class DiscordCompetitionRolePublisher implements CompetitionRolePublisher {
  public constructor(private readonly client: Pick<Client, 'guilds'>) {}

  public async createAndAssign(
    operation: PendingCompetitionRoleOperation,
  ): Promise<{ discordRoleId: string }> {
    try {
      const guild = await this.client.guilds.fetch(operation.guildId);
      const existing = (await guild.roles.fetch()).find(
        (role) => role.name === roleName(operation),
      );
      const role = existing ?? (await guild.roles.create({ name: roleName(operation) }));
      try {
        await assignMembers(guild, role, operation.memberDiscordUserIds);
      } catch (error) {
        if (existing === undefined)
          await role
            .delete('OSLeaders could not finish competition-role setup')
            .catch(() => undefined);
        throw error;
      }
      return { discordRoleId: role.id };
    } catch (error) {
      throw roleOperationError(error);
    }
  }

  public async cleanup(operation: PendingCompetitionRoleOperation): Promise<void> {
    if (operation.discordRoleId === null) return;
    try {
      const guild = await this.client.guilds.fetch(operation.guildId);
      const role = await guild.roles.fetch(operation.discordRoleId);
      if (role === null) return;
      await removeMembers(guild, role, operation.memberDiscordUserIds);
      await role.delete('OSLeaders competition completed or was cancelled');
    } catch (error) {
      throw roleOperationError(error);
    }
  }

  public async syncAssignments(operation: PendingCompetitionRoleOperation): Promise<void> {
    if (operation.discordRoleId === null) return;
    try {
      const guild = await this.client.guilds.fetch(operation.guildId);
      const role = await guild.roles.fetch(operation.discordRoleId);
      if (role === null)
        throw new MissingCompetitionRoleError('The stored competition role no longer exists.');
      const eligibleMembers = new Set(operation.memberDiscordUserIds);
      for (const member of role.members.values())
        if (!eligibleMembers.has(member.id)) await member.roles.remove(role);
      await assignMembers(guild, role, operation.memberDiscordUserIds);
    } catch (error) {
      throw roleOperationError(error);
    }
  }
}

async function assignMembers(
  guild: Guild,
  role: Role,
  discordUserIds: readonly string[],
): Promise<void> {
  for (const discordUserId of discordUserIds) {
    const member = await fetchMember(guild, discordUserId);
    if (member !== undefined && !member.roles.cache.has(role.id)) await member.roles.add(role);
  }
}

async function removeMembers(
  guild: Guild,
  role: Role,
  discordUserIds: readonly string[],
): Promise<void> {
  for (const discordUserId of discordUserIds) {
    const member = await fetchMember(guild, discordUserId);
    if (member?.roles.cache.has(role.id)) await member.roles.remove(role);
  }
}

async function fetchMember(guild: Guild, discordUserId: string): Promise<GuildMember | undefined> {
  try {
    return await guild.members.fetch(discordUserId);
  } catch {
    return undefined;
  }
}

function roleName(operation: PendingCompetitionRoleOperation): string {
  return `OSLeaders \u00B7 ${operation.competitionId} \u00B7 ${operation.displayName}`.slice(
    0,
    100,
  );
}

function roleOperationError(error: unknown): Error {
  if (
    error instanceof MissingCompetitionRoleError ||
    error instanceof CompetitionRolePermissionError
  )
    return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 50_001 || error.code === 50_013)
  ) {
    return new CompetitionRolePermissionError(
      'Discord denied the bot permission to manage this role.',
    );
  }
  return error instanceof Error ? error : new Error('Unexpected Discord competition-role failure.');
}
