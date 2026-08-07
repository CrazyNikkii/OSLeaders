import {
  OSRS_BOSS_ACTIVITY_NAMES,
  OSRS_SKILL_NAMES,
} from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

export const COMPETITION_TYPES = [
  'most_skill_xp',
  'skill_xp_target_race',
  'most_boss_kc',
  'boss_kc_target_race',
] as const;

export type CompetitionType = (typeof COMPETITION_TYPES)[number];
export type CompetitionMetric = { kind: 'skill'; name: string } | { kind: 'boss'; name: string };

const MAX_DURATION_SECONDS = 2_147_483_647;
const MAX_TARGET_VALUE = 9_223_372_036_854_775_807n;

export interface CompetitionDraft {
  createdAt: Date;
  createdByDiscordUserId: string;
  displayName: string;
  durationSeconds: number | null;
  guildId: string;
  id: string;
  metric: CompetitionMetric;
  normalizedName: string;
  state: 'draft';
  targetValue: bigint | null;
  timezone: string;
  type: CompetitionType;
  updatedAt: Date;
}

interface CompetitionCreationRequestBase {
  createdByDiscordUserId: string;
  guildId: string;
  hasAdministratorPermission: boolean;
  memberRoleIds: readonly string[];
  name: string;
  timezone: string;
}

export type CreateCompetitionRequest =
  | (CompetitionCreationRequestBase & {
      durationSeconds: number;
      metric: { kind: 'skill'; name: string };
      type: 'most_skill_xp';
    })
  | (CompetitionCreationRequestBase & {
      durationSeconds: number;
      metric: { kind: 'boss'; name: string };
      type: 'most_boss_kc';
    })
  | (CompetitionCreationRequestBase & {
      metric: { kind: 'skill'; name: string };
      targetValue: bigint;
      type: 'skill_xp_target_race';
    })
  | (CompetitionCreationRequestBase & {
      metric: { kind: 'boss'; name: string };
      targetValue: bigint;
      type: 'boss_kc_target_race';
    });

export interface CompetitionCreationPermissionEvaluator {
  evaluate(request: {
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
  }): Promise<{ canManageCompetitions: boolean }>;
}

export interface CompetitionCreationRepository {
  create(
    draft: CompetitionDraft,
  ): Promise<{ kind: 'created'; competition: CompetitionDraft } | { kind: 'name_taken' }>;
}

export type CreateCompetitionResult =
  | { kind: 'created'; competition: CompetitionDraft }
  | { kind: 'forbidden' }
  | { kind: 'invalid_definition' }
  | { kind: 'name_taken' };

export class CompetitionCreationService {
  public constructor(
    private readonly repository: CompetitionCreationRepository,
    private readonly permissions: CompetitionCreationPermissionEvaluator,
    private readonly createId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async create(request: CreateCompetitionRequest): Promise<CreateCompetitionResult> {
    const permissions = await this.permissions.evaluate({
      guildId: request.guildId,
      hasAdministratorPermission: request.hasAdministratorPermission,
      memberRoleIds: request.memberRoleIds,
    });
    if (!permissions.canManageCompetitions) {
      return { kind: 'forbidden' };
    }

    const name = normalizeCompetitionName(request.name);
    if (name === undefined || !isValidDefinition(request)) {
      return { kind: 'invalid_definition' };
    }

    const timestamp = this.now();
    return this.repository.create({
      createdAt: timestamp,
      createdByDiscordUserId: request.createdByDiscordUserId,
      displayName: name.displayName,
      durationSeconds:
        request.type === 'most_skill_xp' || request.type === 'most_boss_kc'
          ? request.durationSeconds
          : null,
      guildId: request.guildId,
      id: this.createId(),
      metric: request.metric,
      normalizedName: name.normalizedName,
      state: 'draft',
      targetValue:
        request.type === 'skill_xp_target_race' || request.type === 'boss_kc_target_race'
          ? request.targetValue
          : null,
      timezone: request.timezone,
      type: request.type,
      updatedAt: timestamp,
    });
  }
}

export function normalizeCompetitionName(
  value: string,
): { displayName: string; normalizedName: string } | undefined {
  const displayName = value.trim().replaceAll(/\s+/g, ' ');
  return displayName.length === 0
    ? undefined
    : { displayName, normalizedName: displayName.toLocaleLowerCase('en-US') };
}

function isValidDefinition(request: CreateCompetitionRequest): boolean {
  if (!isKnownMetric(request.metric) || !isIanaTimezone(request.timezone)) {
    return false;
  }
  switch (request.type) {
    case 'most_skill_xp':
      return (
        request.metric.kind === 'skill' &&
        Number.isSafeInteger(request.durationSeconds) &&
        request.durationSeconds > 0 &&
        request.durationSeconds <= MAX_DURATION_SECONDS
      );
    case 'most_boss_kc':
      return (
        request.metric.kind === 'boss' &&
        Number.isSafeInteger(request.durationSeconds) &&
        request.durationSeconds > 0 &&
        request.durationSeconds <= MAX_DURATION_SECONDS
      );
    case 'skill_xp_target_race':
      return (
        request.metric.kind === 'skill' &&
        request.targetValue > 0n &&
        request.targetValue <= MAX_TARGET_VALUE
      );
    case 'boss_kc_target_race':
      return (
        request.metric.kind === 'boss' &&
        request.targetValue > 0n &&
        request.targetValue <= MAX_TARGET_VALUE
      );
  }
}

function isKnownMetric(metric: CompetitionMetric): boolean {
  return metric.kind === 'skill'
    ? OSRS_SKILL_NAMES.includes(metric.name as (typeof OSRS_SKILL_NAMES)[number])
    : OSRS_BOSS_ACTIVITY_NAMES.includes(metric.name as (typeof OSRS_BOSS_ACTIVITY_NAMES)[number]);
}

function isIanaTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
