export interface GuildMemberPresence {
  discordUserId: string;
  guildId: string;
  isPresent: boolean;
  updatedAt: Date;
}

export interface MemberPresenceRepository {
  getMemberPresence(
    guildId: string,
    discordUserId: string,
  ): Promise<GuildMemberPresence | undefined>;
  markMemberAbsent(guildId: string, discordUserId: string): Promise<GuildMemberPresence>;
  markMemberPresent(guildId: string, discordUserId: string): Promise<GuildMemberPresence>;
}

export class MemberPresenceService {
  public constructor(private readonly repository: MemberPresenceRepository) {}

  public get(guildId: string, discordUserId: string): Promise<GuildMemberPresence | undefined> {
    return this.repository.getMemberPresence(guildId, discordUserId);
  }

  public markAbsent(guildId: string, discordUserId: string): Promise<GuildMemberPresence> {
    return this.repository.markMemberAbsent(guildId, discordUserId);
  }

  public markPresent(guildId: string, discordUserId: string): Promise<GuildMemberPresence> {
    return this.repository.markMemberPresent(guildId, discordUserId);
  }
}
