export const ADMINISTRATIVE_LOG_MODES = ['standard', 'verbose'] as const;

export type AdministrativeLogMode = (typeof ADMINISTRATIVE_LOG_MODES)[number];

export interface GuildConfiguration {
  administrativeLogChannelId: string | null;
  administrativeLogMode: AdministrativeLogMode;
  botManagerRoleId: string | null;
  competitionManagerRoleId: string | null;
  guildId: string;
}

export interface GuildConfigurationUpdate {
  administrativeLogChannelId?: string | null;
  administrativeLogMode?: AdministrativeLogMode;
  botManagerRoleId?: string | null;
  competitionManagerRoleId?: string | null;
}

export interface GuildConfigurationRepository {
  getOrCreate(guildId: string): Promise<GuildConfiguration>;
  update(guildId: string, update: GuildConfigurationUpdate): Promise<GuildConfiguration>;
}

export class GuildConfigurationService {
  public constructor(private readonly repository: GuildConfigurationRepository) {}

  public getOrCreate(guildId: string): Promise<GuildConfiguration> {
    return this.repository.getOrCreate(guildId);
  }

  public update(guildId: string, update: GuildConfigurationUpdate): Promise<GuildConfiguration> {
    return this.repository.update(guildId, update);
  }
}
