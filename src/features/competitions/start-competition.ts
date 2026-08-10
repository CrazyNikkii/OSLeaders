import type { TrackedAccount } from '../accounts/register-account.js';
import type {
  HiscoreFailure,
  HiscoreParseResult,
} from '../../infrastructure/hiscores/hiscore-result.js';
import type { OsrsHiscoreEndpoint } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';
import { OSRS_MODE_FETCH_STRATEGIES } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

import type { CompetitionMetric } from './create-competition.js';
import type { CompetitionStartFailureReporter } from './report-competition-start-failures.js';

export interface CompetitionStartPermissionEvaluator {
  evaluate(request: {
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
  }): Promise<{ canManageCompetitions: boolean }>;
}

export interface CompetitionStartAccount extends TrackedAccount {
  competitionEntrantId: string;
}

export interface CompetitionReadyToStart {
  startAttemptCount: number;
  competitionId: string;
  durationSeconds: number | null;
  guildId: string;
  metric: CompetitionMetric;
  accounts: readonly CompetitionStartAccount[];
}

export interface CompetitionStartingSnapshot {
  account: CompetitionStartAccount;
  value: bigint;
}

export interface CompetitionStartRepository {
  beginStart(request: {
    canManageCompetitions: boolean;
    competitionId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<CompetitionStartBeginResult>;
  completeStart(request: {
    competitionId: string;
    guildId: string;
    snapshots: readonly CompetitionStartingSnapshot[];
    startedAt: Date;
  }): Promise<CompetitionStartCompleteResult>;
  scheduleRetry(request: {
    competitionId: string;
    failureSummary: string;
    guildId: string;
    nextAttemptAt: Date;
  }): Promise<void>;
  claimDueStart(): Promise<CompetitionReadyToStart | undefined>;
}

export type CompetitionStartBeginResult =
  | { kind: 'ready_to_start'; competition: CompetitionReadyToStart }
  | { kind: 'competition_not_found' }
  | { kind: 'forbidden' }
  | { kind: 'no_entrants' }
  | { kind: 'start_locked' };

export type CompetitionStartCompleteResult =
  | {
      kind: 'started';
      competitionId: string;
      guildId: string;
      startedAt: Date;
      endsAt: Date | null;
    }
  | { kind: 'start_locked' };

export interface CompetitionStartFailure {
  account: CompetitionStartAccount;
  failure: HiscoreFailure;
}

export type CompetitionStartResult =
  | Extract<
      CompetitionStartBeginResult,
      { kind: 'competition_not_found' | 'forbidden' | 'no_entrants' | 'start_locked' }
    >
  | Extract<CompetitionStartCompleteResult, { kind: 'started' | 'start_locked' }>
  | {
      kind: 'start_pending';
      competitionId: string;
      guildId: string;
      failures: readonly CompetitionStartFailure[];
    };

export type CompetitionStartHiscoreResult =
  | HiscoreParseResult
  | Extract<HiscoreFailure, { kind: 'not_found' | 'timeout' | 'temporary_upstream_failure' }>;

export interface CompetitionStartHiscoreFetcher {
  fetchHiscores(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
    options: { cacheMode: 'bypass' },
  ): Promise<CompetitionStartHiscoreResult>;
}

export class CompetitionStartService {
  public constructor(
    private readonly repository: CompetitionStartRepository,
    private readonly permissions: CompetitionStartPermissionEvaluator,
    private readonly hiscores: CompetitionStartHiscoreFetcher,
    private readonly now: () => Date = () => new Date(),
    private readonly failureReporter: CompetitionStartFailureReporter = {
      report: () => Promise.resolve(),
    },
  ) {}

  public async start(request: {
    competitionId: string;
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
  }): Promise<CompetitionStartResult> {
    const permissions = await this.permissions.evaluate({
      guildId: request.guildId,
      hasAdministratorPermission: request.hasAdministratorPermission,
      memberRoleIds: request.memberRoleIds,
    });
    const begin = await this.repository.beginStart({
      canManageCompetitions: permissions.canManageCompetitions,
      competitionId: request.competitionId,
      guildId: request.guildId,
      requesterDiscordUserId: request.requesterDiscordUserId,
    });
    if (begin.kind !== 'ready_to_start') {
      return begin;
    }

    return this.startReady(begin.competition);
  }

  public async retryDue(): Promise<CompetitionStartResult | { kind: 'no_due_start' }> {
    const competition = await this.repository.claimDueStart();
    if (competition === undefined) {
      return { kind: 'no_due_start' };
    }
    return this.startReady(competition);
  }

  private async startReady(competition: CompetitionReadyToStart): Promise<CompetitionStartResult> {
    const outcomes = await Promise.all(
      competition.accounts.map((account) => this.fetchStartingValue(account, competition.metric)),
    );
    const failures = outcomes.filter(
      (outcome): outcome is { kind: 'failure'; failure: CompetitionStartFailure } =>
        outcome.kind === 'failure',
    );
    if (failures.length > 0) {
      await this.repository.scheduleRetry({
        competitionId: competition.competitionId,
        failureSummary: summarizeFailures(failures.map((outcome) => outcome.failure)),
        guildId: competition.guildId,
        nextAttemptAt: new Date(this.now().getTime() + retryDelayMs(competition.startAttemptCount)),
      });
      try {
        await this.failureReporter.report(
          competition.guildId,
          failures.map((outcome) => outcome.failure),
        );
      } catch {
        // Administrative audit delivery must not interrupt durable retry scheduling.
      }
      return {
        kind: 'start_pending',
        competitionId: competition.competitionId,
        guildId: competition.guildId,
        failures: failures.map((outcome) => outcome.failure),
      };
    }

    return this.repository.completeStart({
      competitionId: competition.competitionId,
      guildId: competition.guildId,
      snapshots: outcomes.map((outcome) => {
        if (outcome.kind !== 'snapshot') {
          throw new Error('Successful competition start must contain only snapshots.');
        }
        return outcome.snapshot;
      }),
      startedAt: this.now(),
    });
  }

  private async fetchStartingValue(
    account: CompetitionStartAccount,
    metric: CompetitionMetric,
  ): Promise<
    | { kind: 'snapshot'; snapshot: CompetitionStartingSnapshot }
    | { kind: 'failure'; failure: CompetitionStartFailure }
  > {
    const result = await this.hiscores.fetchHiscores(
      OSRS_MODE_FETCH_STRATEGIES[account.accountMode].endpoint,
      account.displayUsername,
      { cacheMode: 'bypass' },
    );
    if (result.kind !== 'success') {
      return { kind: 'failure', failure: { account, failure: result } };
    }
    const value =
      metric.kind === 'skill'
        ? result.data.skills.find((skill) => skill.name === metric.name)?.experience
        : result.data.bosses.find((boss) => boss.name === metric.name)?.score;
    if (value === undefined) {
      return {
        kind: 'failure',
        failure: { account, failure: { kind: 'incomplete_response', missing: [metric.name] } },
      };
    }
    return {
      kind: 'snapshot',
      snapshot: { account, value: BigInt(metric.kind === 'boss' ? Math.max(value, 0) : value) },
    };
  }
}

export function retryDelayMs(startAttemptCount: number): number {
  return startAttemptCount <= 1 ? 60_000 : 10 * 60_000;
}

function summarizeFailures(failures: readonly CompetitionStartFailure[]): string {
  return failures
    .map(({ account, failure }) => `${account.id}:${failure.kind}`)
    .join(', ')
    .slice(0, 500);
}
