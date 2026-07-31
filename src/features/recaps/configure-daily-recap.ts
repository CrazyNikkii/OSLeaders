import type {
  GuildConfiguration,
  GuildConfigurationRepository,
} from '../guild-configuration/guild-configuration-service.js';
import type {
  GuildPermissionRequest,
  GuildPermissions,
} from '../guild-configuration/guild-permission-service.js';
import { isSafeRecurringLocalTime } from './schedule-automatic-daily-recaps.js';

export interface ConfigureDailyRecapRequest {
  enabled: boolean;
  guildId: string;
  hasAdministratorPermission: boolean;
  memberRoleIds: readonly string[];
  recapChannelId: string;
  recapLocalTime: string;
  timezone: string;
}

export interface DailyRecapConfigurationPermissionEvaluator {
  evaluate(request: GuildPermissionRequest): Promise<GuildPermissions>;
}

export type ConfigureDailyRecapResult =
  | { configuration: GuildConfiguration; kind: 'configured' }
  | { kind: 'forbidden' }
  | { kind: 'invalid_local_time' }
  | { kind: 'invalid_timezone' };

export class ConfigureDailyRecapService {
  public constructor(
    private readonly configurations: GuildConfigurationRepository,
    private readonly permissions: DailyRecapConfigurationPermissionEvaluator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async configure(request: ConfigureDailyRecapRequest): Promise<ConfigureDailyRecapResult> {
    const permissions = await this.permissions.evaluate({
      guildId: request.guildId,
      hasAdministratorPermission: request.hasAdministratorPermission,
      memberRoleIds: request.memberRoleIds,
    });
    if (!permissions.canManageAccounts) {
      return { kind: 'forbidden' };
    }
    if (!isLocalTime(request.recapLocalTime)) {
      return { kind: 'invalid_local_time' };
    }
    if (!isIanaTimezone(request.timezone)) {
      return { kind: 'invalid_timezone' };
    }
    if (!isSafeRecurringLocalTime(request.recapLocalTime, request.timezone, this.now())) {
      return { kind: 'invalid_local_time' };
    }

    const configuration = await this.configurations.update(request.guildId, {
      recapChannelId: request.recapChannelId,
      recapEnabled: request.enabled,
      recapLocalTime: request.recapLocalTime,
      timezone: request.timezone,
    });
    return { configuration, kind: 'configured' };
  }
}

export function isLocalTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isIanaTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
