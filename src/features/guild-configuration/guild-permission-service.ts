import type { GuildConfigurationRepository } from './guild-configuration-service.js';

export interface GuildPermissionRequest {
  guildId: string;
  hasAdministratorPermission: boolean;
  memberRoleIds: readonly string[];
}

export interface GuildPermissions {
  canManageAccounts: boolean;
  canManageCompetitions: boolean;
}

export class GuildPermissionService {
  public constructor(private readonly configurationRepository: GuildConfigurationRepository) {}

  public async evaluate(request: GuildPermissionRequest): Promise<GuildPermissions> {
    const configuration = await this.configurationRepository.getOrCreate(request.guildId);

    return {
      canManageAccounts:
        request.hasAdministratorPermission ||
        hasConfiguredRole(request.memberRoleIds, configuration.botManagerRoleId),
      canManageCompetitions:
        request.hasAdministratorPermission ||
        hasConfiguredRole(request.memberRoleIds, configuration.competitionManagerRoleId),
    };
  }
}

function hasConfiguredRole(
  memberRoleIds: readonly string[],
  configuredRoleId: string | null,
): boolean {
  return configuredRoleId !== null && memberRoleIds.includes(configuredRoleId);
}
