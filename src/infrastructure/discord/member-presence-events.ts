import { Events, type Client, type GuildMember } from 'discord.js';

import type { MemberPresenceService } from '../../features/accounts/member-presence.js';

export class DiscordMemberPresenceEventAdapter {
  private readonly pendingGuildTransitions = new Map<string, Promise<void>>();

  public constructor(
    private readonly memberPresence: Pick<
      MemberPresenceService,
      'markAbsent' | 'markPresent' | 'reconcile'
    >,
  ) {}

  public memberJoined(member: DiscordGuildMemberPresenceEvent): Promise<unknown> {
    return this.schedule(member.guild.id, () =>
      this.memberPresence.markPresent(member.guild.id, member.user.id),
    );
  }

  public memberLeft(member: DiscordGuildMemberPresenceEvent): Promise<unknown> {
    return this.schedule(member.guild.id, () =>
      this.memberPresence.markAbsent(member.guild.id, member.user.id),
    );
  }

  public reconcileSnapshot(
    guildId: string,
    loadPresentDiscordUserIds: () => Promise<readonly string[]>,
  ): Promise<void> {
    return this.schedule(guildId, async () =>
      this.memberPresence.reconcile(guildId, await loadPresentDiscordUserIds()),
    ).then(() => undefined);
  }

  private schedule(guildId: string, transition: () => Promise<unknown>): Promise<unknown> {
    const previous = this.pendingGuildTransitions.get(guildId) ?? Promise.resolve();
    const scheduled = previous.catch(() => undefined).then(transition);
    const completed = scheduled.then(
      () => undefined,
      () => undefined,
    );
    this.pendingGuildTransitions.set(guildId, completed);
    void completed.then(() => {
      if (this.pendingGuildTransitions.get(guildId) === completed) {
        this.pendingGuildTransitions.delete(guildId);
      }
    });
    return scheduled;
  }
}

export function bindDiscordMemberPresenceEventAdapter(
  client: Client,
  adapter: DiscordMemberPresenceEventAdapter,
  onError: (error: unknown) => void,
  shouldHandleMember: (member: DiscordGuildMemberPresenceEvent) => boolean = () => true,
): void {
  client.on(Events.GuildMemberAdd, (member) => {
    if (shouldHandleMember(member)) {
      void adapter.memberJoined(member).catch(onError);
    }
  });
  client.on(Events.GuildMemberRemove, (member) => {
    if (shouldHandleMember(member)) {
      void adapter.memberLeft(member).catch(onError);
    }
  });
}

interface DiscordGuildMemberPresenceEvent {
  guild: Pick<GuildMember['guild'], 'id'>;
  user: Pick<GuildMember['user'], 'id'>;
}
