import { Events, type Client, type GuildMember } from 'discord.js';

import type { MemberPresenceService } from '../../features/accounts/member-presence.js';

export class DiscordMemberPresenceEventAdapter {
  private readonly pendingTransitions = new Map<string, Promise<void>>();

  public constructor(
    private readonly memberPresence: Pick<MemberPresenceService, 'markAbsent' | 'markPresent'>,
  ) {}

  public memberJoined(member: DiscordGuildMemberPresenceEvent): Promise<unknown> {
    return this.schedule(member, () =>
      this.memberPresence.markPresent(member.guild.id, member.user.id),
    );
  }

  public memberLeft(member: DiscordGuildMemberPresenceEvent): Promise<unknown> {
    return this.schedule(member, () =>
      this.memberPresence.markAbsent(member.guild.id, member.user.id),
    );
  }

  private schedule(
    member: DiscordGuildMemberPresenceEvent,
    transition: () => Promise<unknown>,
  ): Promise<unknown> {
    const key = `${member.guild.id}:${member.user.id}`;
    const previous = this.pendingTransitions.get(key) ?? Promise.resolve();
    const scheduled = previous.catch(() => undefined).then(transition);
    const completed = scheduled.then(
      () => undefined,
      () => undefined,
    );
    this.pendingTransitions.set(key, completed);
    void completed.then(() => {
      if (this.pendingTransitions.get(key) === completed) {
        this.pendingTransitions.delete(key);
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
