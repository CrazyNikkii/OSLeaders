import type { TrackedAccount } from './register-account.js';

export interface AccountRetrievalRepository {
  getById(guildId: string, accountId: string): Promise<TrackedAccount | undefined>;
  getDefaultForMember(guildId: string, discordUserId: string): Promise<TrackedAccount | undefined>;
  listForGuild(guildId: string): Promise<TrackedAccount[]>;
  listLinkedForMember(guildId: string, discordUserId: string): Promise<TrackedAccount[]>;
}

export class AccountRetrievalService {
  public constructor(private readonly repository: AccountRetrievalRepository) {}

  public getById(guildId: string, accountId: string): Promise<TrackedAccount | undefined> {
    return this.repository.getById(guildId, accountId);
  }

  public getDefaultForMember(
    guildId: string,
    discordUserId: string,
  ): Promise<TrackedAccount | undefined> {
    return this.repository.getDefaultForMember(guildId, discordUserId);
  }

  public listForGuild(guildId: string): Promise<TrackedAccount[]> {
    return this.repository.listForGuild(guildId);
  }

  public listLinkedForMember(guildId: string, discordUserId: string): Promise<TrackedAccount[]> {
    return this.repository.listLinkedForMember(guildId, discordUserId);
  }
}
