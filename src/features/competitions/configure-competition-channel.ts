import type {
  GuildConfiguration,
  GuildConfigurationRepository,
} from '../guild-configuration/guild-configuration-service.js';
import type {
  GuildPermissionRequest,
  GuildPermissions,
} from '../guild-configuration/guild-permission-service.js';

export interface ConfigureCompetitionChannelRequest {
  channelId: string;
  guildId: string;
  hasAdministratorPermission: boolean;
  memberRoleIds: readonly string[];
}

export type ConfigureCompetitionChannelResult =
  { configuration: GuildConfiguration; kind: 'configured' } | { kind: 'forbidden' };

export class ConfigureCompetitionChannelService {
  public constructor(
    private readonly configurations: GuildConfigurationRepository,
    private readonly permissions: {
      evaluate(request: GuildPermissionRequest): Promise<GuildPermissions>;
    },
  ) {}

  public async configure(
    request: ConfigureCompetitionChannelRequest,
  ): Promise<ConfigureCompetitionChannelResult> {
    const permissions = await this.permissions.evaluate({
      guildId: request.guildId,
      hasAdministratorPermission: request.hasAdministratorPermission,
      memberRoleIds: request.memberRoleIds,
    });
    if (!permissions.canManageAccounts) return { kind: 'forbidden' };
    return {
      configuration: await this.configurations.update(request.guildId, {
        competitionChannelId: request.channelId,
      }),
      kind: 'configured',
    };
  }
}
