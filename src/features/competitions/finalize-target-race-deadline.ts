import type {
  HiscoreFailure,
  HiscoreParseResult,
} from '../../infrastructure/hiscores/hiscore-result.js';
import type { OsrsHiscoreEndpoint } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';
import { OSRS_MODE_FETCH_STRATEGIES } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

import type { CompetitionMetric } from './create-competition.js';
import type { TargetRaceDeadlineFailureReporter } from './report-target-race-deadline-failures.js';

export interface TargetRaceDeadlineAccount {
  accountMode: keyof typeof OSRS_MODE_FETCH_STRATEGIES;
  competitionEntrantId: string;
  displayUsername: string;
  id: string;
  startingValue: bigint;
}

export interface DueTargetRaceFinalization {
  accounts: readonly TargetRaceDeadlineAccount[];
  competitionId: string;
  finishAttemptCount: number;
  guildId: string;
  metric: CompetitionMetric;
}

export interface TargetRaceDeadlineFinalizationRepository {
  claimDueFinalization(): Promise<DueTargetRaceFinalization | undefined>;
  completeFinalization(request: {
    competitionId: string;
    finalValues: readonly { accountId: string; entrantId: string; value: bigint }[];
    finalizedAt: Date;
    guildId: string;
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

export type TargetRaceDeadlineHiscoreResult =
  | HiscoreParseResult
  | Extract<HiscoreFailure, { kind: 'not_found' | 'timeout' | 'temporary_upstream_failure' }>;

export interface TargetRaceDeadlineHiscoreFetcher {
  fetchHiscores(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
    options: { cacheMode: 'bypass' },
  ): Promise<TargetRaceDeadlineHiscoreResult>;
}

export type TargetRaceDeadlineFinalizationResult =
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
      winnerEntrantIds: readonly string[];
    }
  | { kind: 'finish_locked' };

export class TargetRaceDeadlineFinalizationService {
  public constructor(
    private readonly repository: TargetRaceDeadlineFinalizationRepository,
    private readonly hiscores: TargetRaceDeadlineHiscoreFetcher,
    private readonly now: () => Date = () => new Date(),
    private readonly failureReporter: TargetRaceDeadlineFailureReporter = {
      report: () => Promise.resolve(),
    },
  ) {}

  public async finalizeDue(): Promise<TargetRaceDeadlineFinalizationResult> {
    const competition = await this.repository.claimDueFinalization();
    if (competition === undefined) return { kind: 'no_due_finalization' };
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
      finalizedAt: this.now(),
      guildId: competition.guildId,
    });
    return result.kind === 'finish_locked'
      ? result
      : { ...result, competitionId: competition.competitionId, guildId: competition.guildId };
  }

  private fetchAll(accounts: readonly TargetRaceDeadlineAccount[], metric: CompetitionMetric) {
    return Promise.all(accounts.map((account) => this.fetchValue(account, metric)));
  }

  private async fetchValue(
    account: TargetRaceDeadlineAccount,
    metric: CompetitionMetric,
  ): Promise<
    | { account: TargetRaceDeadlineAccount; kind: 'success'; value: bigint }
    | { account: TargetRaceDeadlineAccount; kind: 'failure'; failure: HiscoreFailure }
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
