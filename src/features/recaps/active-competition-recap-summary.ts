import type {
  CompetitionStandingEntry,
  CompetitionStandingsResult,
} from '../competitions/competition-standings.js';

export interface ActiveCompetitionRecapChoices {
  listActive(guildId: string): Promise<readonly { displayName: string; id: string }[]>;
}

export interface ActiveCompetitionRecapStandings {
  getStandings(request: {
    competitionId: string;
    guildId: string;
  }): Promise<CompetitionStandingsResult>;
}

export interface DailyRecapCompetitionSummary {
  displayName: string;
  endsAt: Date | null;
  entries: readonly DailyRecapCompetitionSummaryEntry[];
  hasIncompleteScores: boolean;
  metric: { kind: 'skill' | 'boss'; name: string };
  targetValue: bigint | null;
}

export interface DailyRecapCompetitionSummaryEntry {
  discordUserId: string | null;
  gain: bigint;
  rank: number;
}

export interface DailyRecapCompetitionSummaryResult {
  summaries: readonly DailyRecapCompetitionSummary[];
  unavailableCompetitionNames: readonly string[];
}

export interface DailyRecapCompetitionSummaryProvider {
  summarize(guildId: string): Promise<DailyRecapCompetitionSummaryResult>;
}

export class DailyRecapCompetitionSummaryService implements DailyRecapCompetitionSummaryProvider {
  public constructor(
    private readonly choices: ActiveCompetitionRecapChoices,
    private readonly standings: ActiveCompetitionRecapStandings,
  ) {}

  public async summarize(guildId: string): Promise<DailyRecapCompetitionSummaryResult> {
    let competitions: readonly { displayName: string; id: string }[];
    try {
      competitions = await this.choices.listActive(guildId);
    } catch {
      return { summaries: [], unavailableCompetitionNames: ['active competitions'] };
    }

    const outcomes = await Promise.all(
      competitions.map(async (competition) => {
        try {
          const standings = await this.standings.getStandings({
            competitionId: competition.id,
            guildId,
          });
          return { competition, standings };
        } catch {
          return { competition, standings: undefined };
        }
      }),
    );
    const summaries: DailyRecapCompetitionSummary[] = [];
    const unavailableCompetitionNames: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.standings?.kind !== 'standings') {
        unavailableCompetitionNames.push(outcome.competition.displayName);
        continue;
      }
      summaries.push({
        displayName: outcome.competition.displayName,
        endsAt: outcome.standings.endsAt,
        entries: outcome.standings.entries.slice(0, 3).map(toSummaryEntry),
        hasIncompleteScores: outcome.standings.failures.length > 0,
        metric: outcome.standings.metric,
        targetValue: outcome.standings.targetValue,
      });
    }
    return { summaries, unavailableCompetitionNames };
  }
}

function toSummaryEntry(entry: CompetitionStandingEntry): DailyRecapCompetitionSummaryEntry {
  return {
    discordUserId: entry.discordUserId,
    gain: entry.gain,
    rank: entry.rank,
  };
}
