import type {
  HiscoreFailure,
  HiscoreParseResult,
} from '../../infrastructure/hiscores/hiscore-result.js';
import type { OsrsHiscoreEndpoint } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';
import { OSRS_MODE_FETCH_STRATEGIES } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

import type { CompetitionMetric } from './create-competition.js';

export interface CompetitionStandingAccount {
  accountMode: keyof typeof OSRS_MODE_FETCH_STRATEGIES;
  displayUsername: string;
  entrantDiscordUserId: string | null;
  entrantId: string;
  id: string;
  lastKnownValue: bigint;
  startingValue: bigint;
}

export interface ActiveCompetitionForStandings {
  accounts: readonly CompetitionStandingAccount[];
  competitionId: string;
  endsAt: Date | null;
  guildId: string;
  metric: CompetitionMetric;
  targetValue: bigint | null;
}

export interface CompetitionStandingsRepository {
  findActive(request: {
    competitionId: string;
    guildId: string;
  }): Promise<ActiveCompetitionForStandings | { kind: 'competition_not_found' | 'not_active' }>;
  recordObservedValues(request: {
    competitionId: string;
    guildId: string;
    observedAt: Date;
    values: readonly { accountId: string; value: bigint }[];
  }): Promise<void>;
}

export interface CompetitionStandingAccountResult {
  currentValue: bigint;
  displayUsername: string;
  gain: bigint;
  id: string;
  isCurrentValueStale: boolean;
  startingValue: bigint;
}

export interface CompetitionStandingEntry {
  accounts: readonly CompetitionStandingAccountResult[];
  discordUserId: string | null;
  entrantId: string;
  gain: bigint;
  isPotentiallyIncomplete: boolean;
  rank: number;
}

export type CompetitionStandingsResult =
  | {
      kind: 'standings';
      competitionId: string;
      endsAt: Date | null;
      entries: readonly CompetitionStandingEntry[];
      failures: readonly { accountId: string; failure: HiscoreFailure }[];
      metric: CompetitionMetric;
      targetValue: bigint | null;
    }
  | { kind: 'competition_not_found' | 'not_active' };

export type CompetitionStandingsHiscoreResult =
  | HiscoreParseResult
  | Extract<HiscoreFailure, { kind: 'not_found' | 'timeout' | 'temporary_upstream_failure' }>;

export interface CompetitionStandingsHiscoreFetcher {
  fetchHiscores(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
  ): Promise<CompetitionStandingsHiscoreResult>;
}

export class CompetitionStandingsService {
  public constructor(
    private readonly repository: CompetitionStandingsRepository,
    private readonly hiscores: CompetitionStandingsHiscoreFetcher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getStandings(request: {
    competitionId: string;
    guildId: string;
  }): Promise<CompetitionStandingsResult> {
    const competition = await this.repository.findActive(request);
    if ('kind' in competition) return competition;

    const outcomes = await Promise.all(
      competition.accounts.map((account) => this.fetchCurrentValue(account, competition.metric)),
    );
    const observedAt = this.now();
    const values = outcomes.flatMap((outcome) =>
      outcome.kind === 'success' ? [{ accountId: outcome.account.id, value: outcome.value }] : [],
    );
    if (values.length > 0) {
      await this.repository.recordObservedValues({
        competitionId: competition.competitionId,
        guildId: competition.guildId,
        observedAt,
        values,
      });
    }

    const failures: { accountId: string; failure: HiscoreFailure }[] = [];
    const byEntrant = new Map<
      string,
      { accounts: CompetitionStandingAccountResult[]; discordUserId: string | null }
    >();
    for (const outcome of outcomes) {
      const account = outcome.account;
      const currentValue = outcome.kind === 'success' ? outcome.value : account.lastKnownValue;
      if (outcome.kind === 'failure')
        failures.push({ accountId: account.id, failure: outcome.failure });
      const entrant = byEntrant.get(account.entrantId) ?? {
        accounts: [],
        discordUserId: account.entrantDiscordUserId,
      };
      entrant.accounts.push({
        currentValue,
        displayUsername: account.displayUsername,
        gain: nonNegativeGain(currentValue, account.startingValue),
        id: account.id,
        isCurrentValueStale: outcome.kind === 'failure',
        startingValue: account.startingValue,
      });
      byEntrant.set(account.entrantId, entrant);
    }
    const entries = [...byEntrant.entries()].map(([entrantId, entrant]) => ({
      accounts: entrant.accounts.sort((left, right) => left.id.localeCompare(right.id, 'en-US')),
      discordUserId: entrant.discordUserId,
      entrantId,
      gain: entrant.accounts.reduce((total, account) => total + account.gain, 0n),
      isPotentiallyIncomplete: entrant.accounts.some((account) => account.isCurrentValueStale),
      rank: 0,
    }));
    entries.sort((left, right) =>
      right.gain === left.gain
        ? left.entrantId.localeCompare(right.entrantId, 'en-US')
        : right.gain > left.gain
          ? 1
          : -1,
    );
    let previousGain: bigint | undefined;
    let previousRank = 0;
    entries.forEach((entry, index) => {
      entry.rank = previousGain === entry.gain ? previousRank : index + 1;
      previousGain = entry.gain;
      previousRank = entry.rank;
    });
    return {
      competitionId: competition.competitionId,
      endsAt: competition.endsAt,
      entries,
      failures,
      kind: 'standings',
      metric: competition.metric,
      targetValue: competition.targetValue,
    };
  }

  private async fetchCurrentValue(
    account: CompetitionStandingAccount,
    metric: CompetitionMetric,
  ): Promise<
    | { account: CompetitionStandingAccount; kind: 'success'; value: bigint }
    | { account: CompetitionStandingAccount; failure: HiscoreFailure; kind: 'failure' }
  > {
    const result = await this.hiscores.fetchHiscores(
      OSRS_MODE_FETCH_STRATEGIES[account.accountMode].endpoint,
      account.displayUsername,
    );
    if (result.kind !== 'success') return { account, failure: result, kind: 'failure' };
    const value =
      metric.kind === 'skill'
        ? result.data.skills.find((skill) => skill.name === metric.name)?.experience
        : result.data.bosses.find((boss) => boss.name === metric.name)?.score;
    if (value === undefined) {
      return {
        account,
        failure: { kind: 'incomplete_response', missing: [metric.name] },
        kind: 'failure',
      };
    }
    return {
      account,
      kind: 'success',
      value: BigInt(metric.kind === 'boss' ? Math.max(value, 0) : value),
    };
  }
}

function nonNegativeGain(currentValue: bigint, startingValue: bigint): bigint {
  return currentValue > startingValue ? currentValue - startingValue : 0n;
}
