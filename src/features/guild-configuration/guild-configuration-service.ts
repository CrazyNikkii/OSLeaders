import type { OsrsAccountMode } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

export const ADMINISTRATIVE_LOG_MODES = ['standard', 'verbose'] as const;

export type AdministrativeLogMode = (typeof ADMINISTRATIVE_LOG_MODES)[number];

export interface GuildModeEmoji {
  animated?: boolean;
  id: string;
  name: string;
}

export type GuildModeEmojis = Partial<Record<OsrsAccountMode, GuildModeEmoji>>;

export interface GuildConfiguration {
  administrativeLogChannelId: string | null;
  administrativeLogMode: AdministrativeLogMode;
  botManagerRoleId: string | null;
  competitionManagerRoleId: string | null;
  guildId: string;
  modeEmojis: GuildModeEmojis;
}

export interface GuildConfigurationUpdate {
  administrativeLogChannelId?: string | null;
  administrativeLogMode?: AdministrativeLogMode;
  botManagerRoleId?: string | null;
  competitionManagerRoleId?: string | null;
  modeEmojis?: GuildModeEmojis;
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
