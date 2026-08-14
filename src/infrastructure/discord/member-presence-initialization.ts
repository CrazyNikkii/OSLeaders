import type { Client } from 'discord.js';

export interface DiscordMemberPresenceSnapshotReconciler {
  reconcileSnapshot(
    guildId: string,
    loadPresentDiscordUserIds: () => Promise<readonly string[]>,
  ): Promise<void>;
}

/** Reconciles the configured guild's current members before role work is recovered. */
export async function initializeDiscordGuildMemberPresence(
  client: Pick<Client, 'guilds'>,
  memberPresence: DiscordMemberPresenceSnapshotReconciler,
  guildId: string,
): Promise<void> {
  await memberPresence.reconcileSnapshot(guildId, async () => {
    const guild = await client.guilds.fetch(guildId);
    const members = await guild.members.fetch();
    return [...members.values()].map((member) => member.user.id);
  });
}
