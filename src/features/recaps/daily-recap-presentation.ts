import type { TrackedAccount } from '../accounts/register-account.js';
import type {
  DailyRecapAccountChanges,
  DailyRecapCollectionFailure,
  DailyRecapCollectionResult,
} from './daily-recap-collection.js';
import type {
  DailyRecapCompetitionSummary,
  DailyRecapCompetitionSummaryProvider,
} from './active-competition-recap-summary.js';

export interface DailyRecapAccountPresentation {
  account: TrackedAccount;
  changes: DailyRecapAccountChanges;
  previousBaselineCapturedAt: Date;
}

export interface DailyRecapLinkedMemberPresentation {
  accounts: readonly DailyRecapAccountPresentation[];
  discordUserId: string;
}

export interface DailyRecapFailurePresentation {
  account: TrackedAccount;
  failure: DailyRecapCollectionFailure;
}

export interface DailyRecapPresentation {
  activeCompetitionSummaries?: readonly DailyRecapCompetitionSummary[];
  failures: readonly DailyRecapFailurePresentation[];
  linkedMembers: readonly DailyRecapLinkedMemberPresentation[];
  noActivity: boolean;
  unavailableCompetitionNames?: readonly string[];
  watchlistAccounts: readonly DailyRecapAccountPresentation[];
}

export interface DailyRecapPreview {
  collection: DailyRecapCollectionResult;
  presentation: DailyRecapPresentation;
}

export const MINIMUM_VISIBLE_DAILY_RECAP_XP = 10_000;

export interface DailyRecapPreviewCollector {
  collect(guildId: string): Promise<DailyRecapCollectionResult>;
}

export class DailyRecapPreviewService {
  public constructor(
    private readonly collector: DailyRecapPreviewCollector,
    private readonly competitions: DailyRecapCompetitionSummaryProvider = noCompetitionSummaries,
  ) {}

  public async preview(guildId: string): Promise<DailyRecapPreview> {
    const collection = await this.collector.collect(guildId);
    const presentation = await presentDailyRecapWithCompetitionSummaries(
      collection,
      this.competitions,
    );
    return { collection, presentation };
  }
}

export function presentDailyRecap(collection: DailyRecapCollectionResult): DailyRecapPresentation {
  const linkedMembers = new Map<string, DailyRecapAccountPresentation[]>();
  const watchlistAccounts: DailyRecapAccountPresentation[] = [];
  const failures: DailyRecapFailurePresentation[] = [];

  for (const outcome of collection.outcomes) {
    if (outcome.kind === 'failure') {
      failures.push({ account: outcome.account, failure: outcome.failure });
      continue;
    }

    const changes = visibleChanges(outcome.changes);
    if (!hasChanges(changes)) {
      continue;
    }

    const account = {
      account: outcome.account,
      changes,
      previousBaselineCapturedAt: outcome.previousBaselineCapturedAt,
    };
    if (outcome.account.association.type === 'watchlist') {
      watchlistAccounts.push(account);
      continue;
    }

    const memberAccounts = linkedMembers.get(outcome.account.association.discordUserId) ?? [];
    memberAccounts.push(account);
    linkedMembers.set(outcome.account.association.discordUserId, memberAccounts);
  }

  const members = [...linkedMembers.entries()].map(([discordUserId, accounts]) => ({
    accounts,
    discordUserId,
  }));
  return {
    activeCompetitionSummaries: [],
    failures,
    linkedMembers: members,
    noActivity: members.length === 0 && watchlistAccounts.length === 0,
    unavailableCompetitionNames: [],
    watchlistAccounts,
  };
}

export async function presentDailyRecapWithCompetitionSummaries(
  collection: DailyRecapCollectionResult,
  competitions: DailyRecapCompetitionSummaryProvider,
): Promise<DailyRecapPresentation> {
  const presentation = presentDailyRecap(collection);
  try {
    const summaries = await competitions.summarize(collection.guildId);
    return {
      ...presentation,
      activeCompetitionSummaries: summaries.summaries,
      unavailableCompetitionNames: summaries.unavailableCompetitionNames,
    };
  } catch {
    return { ...presentation, unavailableCompetitionNames: ['active competitions'] };
  }
}

const noCompetitionSummaries: DailyRecapCompetitionSummaryProvider = {
  summarize: () => Promise.resolve({ summaries: [], unavailableCompetitionNames: [] }),
};

function visibleChanges(changes: DailyRecapAccountChanges): DailyRecapAccountChanges {
  return {
    bosses: changes.bosses,
    skills: changes.skills.filter(
      (skill) => skill.levelGained > 0 || skill.experienceGained >= MINIMUM_VISIBLE_DAILY_RECAP_XP,
    ),
  };
}

function hasChanges(changes: DailyRecapAccountChanges): boolean {
  return changes.skills.length > 0 || changes.bosses.length > 0;
}
