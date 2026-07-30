import type { InitialRecapBaseline, TrackedAccount } from '../accounts/register-account.js';
import type {
  HiscoreFailure,
  HiscoreParseResult,
} from '../../infrastructure/hiscores/hiscore-result.js';
import {
  OSRS_BOSS_ACTIVITY_NAMES,
  OSRS_MODE_FETCH_STRATEGIES,
  OSRS_SKILL_NAMES,
  type OsrsHiscoreEndpoint,
} from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

export type RecapBaseline = InitialRecapBaseline;

export interface RecapCollectionAccount {
  account: TrackedAccount;
  baseline: RecapBaseline;
}

export interface DailyRecapCollectionRepository {
  listForGuild(guildId: string): Promise<readonly RecapCollectionAccount[]>;
}

export interface DailyRecapCollectionHiscoreFetcher {
  fetchHiscores(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
    options: { cacheMode: 'bypass' },
  ): Promise<
    | HiscoreParseResult
    | Extract<HiscoreFailure, { kind: 'not_found' | 'timeout' | 'temporary_upstream_failure' }>
  >;
}

export interface DailyRecapSkillChange {
  currentLevel: number;
  experienceGained: number;
  levelGained: number;
  skill: string;
}

export interface DailyRecapBossChange {
  boss: string;
  killCountGained: number;
}

export interface DailyRecapAccountChanges {
  bosses: readonly DailyRecapBossChange[];
  skills: readonly DailyRecapSkillChange[];
}

export type DailyRecapCollectionFailure =
  HiscoreFailure | { kind: 'baseline_incomplete'; missing: readonly string[] };

export interface DailyRecapCollectionSuccess {
  account: TrackedAccount;
  candidateBaseline: InitialRecapBaseline;
  changes: DailyRecapAccountChanges;
  kind: 'success';
}

export interface DailyRecapCollectionFailureOutcome {
  account: TrackedAccount;
  failure: DailyRecapCollectionFailure;
  kind: 'failure';
}

export type DailyRecapCollectionOutcome =
  DailyRecapCollectionSuccess | DailyRecapCollectionFailureOutcome;

export interface DailyRecapCollectionResult {
  completedAt: Date;
  guildId: string;
  outcomes: readonly DailyRecapCollectionOutcome[];
  startedAt: Date;
}

export class DailyRecapCollectionService {
  public constructor(
    private readonly repository: DailyRecapCollectionRepository,
    private readonly hiscores: DailyRecapCollectionHiscoreFetcher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async collect(guildId: string): Promise<DailyRecapCollectionResult> {
    const startedAt = this.now();
    const accounts = await this.repository.listForGuild(guildId);
    const outcomes = await Promise.all(accounts.map(async (entry) => this.collectAccount(entry)));

    return { completedAt: this.now(), guildId, outcomes, startedAt };
  }

  private async collectAccount(
    entry: RecapCollectionAccount,
  ): Promise<DailyRecapCollectionOutcome> {
    const baselineFailure = validateBaseline(entry.baseline);
    if (baselineFailure !== undefined) {
      return { account: entry.account, failure: baselineFailure, kind: 'failure' };
    }

    const result = await this.hiscores.fetchHiscores(
      OSRS_MODE_FETCH_STRATEGIES[entry.account.accountMode].endpoint,
      entry.account.displayUsername,
      { cacheMode: 'bypass' },
    );
    if (result.kind !== 'success') {
      return { account: entry.account, failure: result, kind: 'failure' };
    }

    const completenessFailure = validateCompleteHiscores(result.data);
    if (completenessFailure !== undefined) {
      return { account: entry.account, failure: completenessFailure, kind: 'failure' };
    }

    const capturedAt = this.now();
    return {
      account: entry.account,
      candidateBaseline: toBaseline(result.data, capturedAt),
      changes: calculateChanges(entry.baseline, result.data),
      kind: 'success',
    };
  }
}

function calculateChanges(
  baseline: RecapBaseline,
  data: Extract<HiscoreParseResult, { kind: 'success' }>['data'],
): DailyRecapAccountChanges {
  const skills = data.skills.flatMap((skill) => {
    const experienceGained = skill.experience - baseline.skillExperience[skill.name]!;
    const levelGained = skill.level - baseline.skillLevels[skill.name]!;
    return experienceGained > 0 || levelGained > 0
      ? [
          {
            currentLevel: skill.level,
            experienceGained: Math.max(experienceGained, 0),
            levelGained: Math.max(levelGained, 0),
            skill: skill.name,
          },
        ]
      : [];
  });
  const bosses = data.bosses.flatMap((boss) => {
    const killCountGained =
      normalizedKillCount(boss.score) - normalizedKillCount(baseline.bossKillCounts[boss.name]!);
    return killCountGained > 0 ? [{ boss: boss.name, killCountGained }] : [];
  });

  return { bosses, skills };
}

function normalizedKillCount(score: number): number {
  return Math.max(score, 0);
}

function toBaseline(
  data: Extract<HiscoreParseResult, { kind: 'success' }>['data'],
  capturedAt: Date,
): InitialRecapBaseline {
  return {
    bossKillCounts: Object.fromEntries(data.bosses.map(({ name, score }) => [name, score])),
    capturedAt,
    skillExperience: Object.fromEntries(
      data.skills.map(({ name, experience }) => [name, experience]),
    ),
    skillLevels: Object.fromEntries(data.skills.map(({ name, level }) => [name, level])),
  };
}

function validateBaseline(
  baseline: RecapBaseline,
): Extract<DailyRecapCollectionFailure, { kind: 'baseline_incomplete' }> | undefined {
  const missing = [
    ...missingNumericValues('skillExperience', OSRS_SKILL_NAMES, baseline.skillExperience),
    ...missingNumericValues('skillLevels', OSRS_SKILL_NAMES, baseline.skillLevels),
    ...missingNumericValues('bossKillCounts', OSRS_BOSS_ACTIVITY_NAMES, baseline.bossKillCounts),
  ];
  return missing.length === 0 ? undefined : { kind: 'baseline_incomplete', missing };
}

function validateCompleteHiscores(
  data: Extract<HiscoreParseResult, { kind: 'success' }>['data'],
): Extract<HiscoreFailure, { kind: 'incomplete_response' }> | undefined {
  const skills = new Set(data.skills.map((skill) => skill.name));
  const bosses = new Set(data.bosses.map((boss) => boss.name));
  const missing = [
    ...OSRS_SKILL_NAMES.filter((name) => !skills.has(name)).map((name) => `skill:${name}`),
    ...OSRS_BOSS_ACTIVITY_NAMES.filter((name) => !bosses.has(name)).map(
      (name) => `activity:${name}`,
    ),
  ];
  return missing.length === 0 ? undefined : { kind: 'incomplete_response', missing };
}

function missingNumericValues(
  category: string,
  names: readonly string[],
  values: Readonly<Record<string, number>>,
): string[] {
  return names
    .filter((name) => !Number.isSafeInteger(values[name]))
    .map((name) => `${category}:${name}`);
}
