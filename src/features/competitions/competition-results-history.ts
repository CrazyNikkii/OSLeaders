import type { CompetitionMetric } from './create-competition.js';
import type { OsrsAccountMode } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

export interface FinishedCompetitionAccount {
  accountMode: OsrsAccountMode;
  displayUsername: string;
  discordUserId: string | null;
  entrantId: string;
  finalValue: bigint | null;
  id: string;
  startingValue: bigint;
}

export interface FinishedCompetitionRecord {
  accounts: readonly FinishedCompetitionAccount[];
  competitionId: string;
  displayName: string;
  finishedAt: Date | null;
  guildId: string;
  isResultDelayed: boolean;
  metric: CompetitionMetric;
  targetValue: bigint | null;
  winners: readonly { entrantId: string; finalGain: bigint }[];
}

export interface CompetitionResultsHistoryRepository {
  findFinished(request: { competitionId: string; guildId: string }): Promise<
    | FinishedCompetitionRecord
    | {
        kind: 'competition_not_found' | 'not_finished' | 'cancelled';
        displayName?: string;
        cancelledAt?: Date;
      }
  >;
  listFinished(
    guildId: string,
  ): Promise<readonly { displayName: string; id: string; state?: 'finished' | 'cancelled' }[]>;
}

export interface FinishedCompetitionResultEntry {
  accounts: readonly {
    accountMode: OsrsAccountMode;
    displayUsername: string;
    finalValue: bigint | null;
    gain: bigint | null;
    startingValue: bigint;
  }[];
  discordUserId: string | null;
  entrantId: string;
  finalGain: bigint | null;
  isWinner: boolean;
  rank: number | null;
}

export type CompetitionResultsHistoryResult =
  | {
      competitionId: string;
      displayName: string;
      entries: readonly FinishedCompetitionResultEntry[];
      finishedAt: Date | null;
      isResultDelayed: boolean;
      kind: 'finished_result';
      metric: CompetitionMetric;
      targetValue: bigint | null;
    }
  | { kind: 'cancelled_result'; displayName: string; cancelledAt: Date }
  | { kind: 'competition_not_found' | 'not_finished' };

/** Builds a read-only, immutable view of a completed competition. */
export class CompetitionResultsHistoryService {
  public constructor(private readonly repository: CompetitionResultsHistoryRepository) {}

  public listFinished(guildId: string) {
    return this.repository.listFinished(guildId);
  }

  public async getFinishedResult(request: {
    competitionId: string;
    guildId: string;
  }): Promise<CompetitionResultsHistoryResult> {
    const competition = await this.repository.findFinished(request);
    if ('kind' in competition) {
      if (
        competition.kind === 'cancelled' &&
        competition.displayName !== undefined &&
        competition.cancelledAt !== undefined
      )
        return {
          kind: 'cancelled_result',
          displayName: competition.displayName,
          cancelledAt: competition.cancelledAt,
        };
      return competition as { kind: 'competition_not_found' | 'not_finished' };
    }

    const winnerGains = new Map(
      competition.winners.map((winner) => [winner.entrantId, winner.finalGain]),
    );
    const entrants = new Map<
      string,
      {
        accounts: {
          accountMode: OsrsAccountMode;
          displayUsername: string;
          finalValue: bigint | null;
          gain: bigint | null;
          startingValue: bigint;
        }[];
        discordUserId: string | null;
      }
    >();
    for (const account of competition.accounts) {
      const entrant = entrants.get(account.entrantId) ?? {
        accounts: [],
        discordUserId: account.discordUserId,
      };
      entrant.accounts.push({
        accountMode: account.accountMode,
        displayUsername: account.displayUsername,
        finalValue: account.finalValue,
        gain:
          account.finalValue === null
            ? null
            : account.finalValue > account.startingValue
              ? account.finalValue - account.startingValue
              : 0n,
        startingValue: account.startingValue,
      });
      entrants.set(account.entrantId, entrant);
    }
    const entries: FinishedCompetitionResultEntry[] = [...entrants.entries()].map(
      ([entrantId, entrant]) => {
        const allFinalValuesAvailable = entrant.accounts.every(
          (account) => account.finalValue !== null,
        );
        return {
          accounts: entrant.accounts.sort((left, right) =>
            left.displayUsername.localeCompare(right.displayUsername, 'en-US'),
          ),
          discordUserId: entrant.discordUserId,
          entrantId,
          finalGain: allFinalValuesAvailable
            ? entrant.accounts.reduce((total, account) => total + (account.gain ?? 0n), 0n)
            : (winnerGains.get(entrantId) ?? null),
          isWinner: winnerGains.has(entrantId),
          rank: null,
        } satisfies FinishedCompetitionResultEntry;
      },
    );
    entries.sort((left, right) => {
      if (left.finalGain === null && right.finalGain === null)
        return left.entrantId.localeCompare(right.entrantId, 'en-US');
      if (left.finalGain === null) return 1;
      if (right.finalGain === null) return -1;
      return right.finalGain === left.finalGain
        ? left.entrantId.localeCompare(right.entrantId, 'en-US')
        : right.finalGain > left.finalGain
          ? 1
          : -1;
    });
    let previousGain: bigint | null = null;
    let previousRank = 0;
    entries.forEach((entry, index) => {
      if (entry.finalGain === null) return;
      entry.rank = previousGain === entry.finalGain ? previousRank : index + 1;
      previousGain = entry.finalGain;
      previousRank = entry.rank;
    });
    return {
      competitionId: competition.competitionId,
      displayName: competition.displayName,
      entries,
      finishedAt: competition.finishedAt,
      isResultDelayed: competition.isResultDelayed,
      kind: 'finished_result',
      metric: competition.metric,
      targetValue: competition.targetValue,
    };
  }
}
