import type {
  HiscoreFailure,
  HiscoreParseResult,
} from '../../infrastructure/hiscores/hiscore-result.js';
import type { OsrsHiscoreEndpoint } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';
import { OSRS_MODE_FETCH_STRATEGIES } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

import type { CompetitionMetric } from './create-competition.js';
import type { TimedCompetitionFinalizationFailureReporter } from './report-timed-competition-finalization-failures.js';

export interface TimedCompetitionFinalizationAccount {
  accountMode: keyof typeof OSRS_MODE_FETCH_STRATEGIES;
  competitionEntrantId: string;
  displayUsername: string;
  id: string;
  startingValue: bigint;
}

export interface DueTimedCompetitionFinalization {
  accounts: readonly TimedCompetitionFinalizationAccount[];
  competitionId: string;
  endsAt: Date;
  finishAttemptCount: number;
  guildId: string;
  metric: CompetitionMetric;
}

export interface TimedCompetitionFinalizationRepository {
  claimDueFinalization(): Promise<DueTimedCompetitionFinalization | undefined>;
  beginManualFinalization(request: {
    canManageCompetitions: boolean;
    competitionId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<TimedCompetitionManualBeginResult>;
  completeFinalization(request: {
    competitionId: string;
    finalValues: readonly { accountId: string; entrantId: string; value: bigint }[];
    finalizedAt: Date;
    guildId: string;
    isResultDelayed: boolean;
  }): Promise<
    { kind: 'finished'; winnerEntrantIds: readonly string[] } | { kind: 'finish_locked' }
  >;
  scheduleRetry(request: {
    competitionId: string;
    failureSummary: string;
    guildId: string;
    nextAttemptAt: Date;
  }): Promise<void>;
}

export interface TimedCompetitionFinalizationPermissionEvaluator {
  evaluate(request: {
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
  }): Promise<{ canManageCompetitions: boolean }>;
}

export type TimedCompetitionManualBeginResult =
  | { kind: 'ready_to_finalize'; competition: DueTimedCompetitionFinalization }
  | { kind: 'competition_not_found' | 'forbidden' | 'finalization_locked' };

export type TimedCompetitionFinalizationHiscoreResult =
  | HiscoreParseResult
  | Extract<HiscoreFailure, { kind: 'not_found' | 'timeout' | 'temporary_upstream_failure' }>;

export interface TimedCompetitionFinalizationHiscoreFetcher {
  fetchHiscores(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
    options: { cacheMode: 'bypass' },
  ): Promise<TimedCompetitionFinalizationHiscoreResult>;
}

export type TimedCompetitionFinalizationResult =
  | { kind: 'no_due_finalization' }
  | {
      kind: 'finish_pending';
      competitionId: string;
      guildId: string;
      failures: readonly HiscoreFailure[];
    }
  | {
      kind: 'finished';
      competitionId: string;
      guildId: string;
      isResultDelayed: boolean;
      winnerEntrantIds: readonly string[];
    }
  | { kind: 'finish_locked' };

export type ManualTimedCompetitionFinalizationResult =
  | Exclude<TimedCompetitionFinalizationResult, { kind: 'no_due_finalization' }>
  | Extract<
      TimedCompetitionManualBeginResult,
      { kind: 'competition_not_found' | 'forbidden' | 'finalization_locked' }
    >;

export class TimedCompetitionFinalizationService {
  public constructor(
    private readonly repository: TimedCompetitionFinalizationRepository,
    private readonly hiscores: TimedCompetitionFinalizationHiscoreFetcher,
    private readonly now: () => Date = () => new Date(),
    private readonly failureReporter: TimedCompetitionFinalizationFailureReporter = {
      report: () => Promise.resolve(),
    },
    private readonly audit?: {
      record(event: {
        context: Record<string, unknown>;
        guildId: string;
        occurredAt: Date;
        operation: string;
        severity: 'info';
        type: 'competition-lifecycle';
      }): unknown;
    },
  ) {}

  public async finalizeDue(): Promise<TimedCompetitionFinalizationResult> {
    const competition = await this.repository.claimDueFinalization();
    if (competition === undefined) return { kind: 'no_due_finalization' };
    return this.finalize(competition);
  }

  public async finalizeManually(
    request: {
      competitionId: string;
      guildId: string;
      hasAdministratorPermission: boolean;
      memberRoleIds: readonly string[];
      requesterDiscordUserId: string;
    },
    permissions: TimedCompetitionFinalizationPermissionEvaluator,
  ): Promise<ManualTimedCompetitionFinalizationResult> {
    const evaluated = await permissions.evaluate({
      guildId: request.guildId,
      hasAdministratorPermission: request.hasAdministratorPermission,
      memberRoleIds: request.memberRoleIds,
    });
    const begin = await this.repository.beginManualFinalization({
      canManageCompetitions: evaluated.canManageCompetitions,
      competitionId: request.competitionId,
      guildId: request.guildId,
      requesterDiscordUserId: request.requesterDiscordUserId,
    });
    if (begin.kind !== 'ready_to_finalize') return begin;
    const result = await this.finalize(begin.competition);
    if (result.kind === 'finished' || result.kind === 'finish_pending') {
      try {
        this.audit?.record({
          context: {
            competitionId: request.competitionId,
            outcome: result.kind,
            requesterDiscordUserId: request.requesterDiscordUserId,
            ...(result.kind === 'finished' ? { isResultDelayed: result.isResultDelayed } : {}),
          },
          guildId: request.guildId,
          occurredAt: this.now(),
          operation: 'competition.manual_finalization',
          severity: 'info',
          type: 'competition-lifecycle',
        });
      } catch {
        // Administrative logging must not undo a durable finalization or retry state.
      }
    }
    return result;
  }

  private async finalize(
    competition: DueTimedCompetitionFinalization,
  ): Promise<Exclude<TimedCompetitionFinalizationResult, { kind: 'no_due_finalization' }>> {
    let outcomes = await this.fetchAll(competition.accounts, competition.metric);
    if (outcomes.some((outcome) => outcome.kind === 'failure'))
      outcomes = await this.fetchAll(competition.accounts, competition.metric);
    const failures = outcomes.flatMap((outcome) =>
      outcome.kind === 'failure' ? [outcome.failure] : [],
    );
    if (failures.length > 0) {
      await this.repository.scheduleRetry({
        competitionId: competition.competitionId,
        failureSummary: failures
          .map((failure) => failure.kind)
          .join(', ')
          .slice(0, 500),
        guildId: competition.guildId,
        nextAttemptAt: new Date(
          this.now().getTime() + retryDelayMs(competition.finishAttemptCount),
        ),
      });
      try {
        await this.failureReporter.report(
          competition.guildId,
          outcomes.filter(
            (outcome): outcome is Extract<typeof outcome, { kind: 'failure' }> =>
              outcome.kind === 'failure',
          ),
        );
      } catch {
        /* Durable retry remains authoritative. */
      }
      return {
        kind: 'finish_pending',
        competitionId: competition.competitionId,
        failures,
        guildId: competition.guildId,
      };
    }
    const finalizedAt = this.now();
    const result = await this.repository.completeFinalization({
      competitionId: competition.competitionId,
      finalValues: outcomes.map((outcome) => {
        if (outcome.kind !== 'success') throw new Error('Expected successful final values.');
        return {
          accountId: outcome.account.id,
          entrantId: outcome.account.competitionEntrantId,
          value: outcome.value,
        };
      }),
      finalizedAt,
      guildId: competition.guildId,
      isResultDelayed: finalizedAt > competition.endsAt,
    });
    return result.kind === 'finish_locked'
      ? result
      : {
          ...result,
          competitionId: competition.competitionId,
          guildId: competition.guildId,
          isResultDelayed: finalizedAt > competition.endsAt,
        };
  }

  private fetchAll(
    accounts: readonly TimedCompetitionFinalizationAccount[],
    metric: CompetitionMetric,
  ) {
    return Promise.all(accounts.map((account) => this.fetchValue(account, metric)));
  }

  private async fetchValue(
    account: TimedCompetitionFinalizationAccount,
    metric: CompetitionMetric,
  ): Promise<
    | { account: TimedCompetitionFinalizationAccount; kind: 'success'; value: bigint }
    | { account: TimedCompetitionFinalizationAccount; kind: 'failure'; failure: HiscoreFailure }
  > {
    const result = await this.hiscores.fetchHiscores(
      OSRS_MODE_FETCH_STRATEGIES[account.accountMode].endpoint,
      account.displayUsername,
      { cacheMode: 'bypass' },
    );
    if (result.kind !== 'success') return { account, failure: result, kind: 'failure' };
    const value =
      metric.kind === 'skill'
        ? result.data.skills.find((skill) => skill.name === metric.name)?.experience
        : result.data.bosses.find((boss) => boss.name === metric.name)?.score;
    if (value === undefined)
      return {
        account,
        failure: { kind: 'incomplete_response', missing: [metric.name] },
        kind: 'failure',
      };
    return {
      account,
      kind: 'success',
      value: BigInt(metric.kind === 'boss' ? Math.max(value, 0) : value),
    };
  }
}

export function retryDelayMs(finishAttemptCount: number): number {
  return finishAttemptCount <= 1 ? 60_000 : 10 * 60_000;
}
