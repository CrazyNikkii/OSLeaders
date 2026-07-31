import type { TrackedAccount } from '../accounts/register-account.js';
import type {
  DailyRecapAccountChanges,
  DailyRecapCollectionFailure,
  DailyRecapCollectionResult,
} from './daily-recap-collection.js';

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
  failures: readonly DailyRecapFailurePresentation[];
  linkedMembers: readonly DailyRecapLinkedMemberPresentation[];
  noActivity: boolean;
  watchlistAccounts: readonly DailyRecapAccountPresentation[];
}

export interface DailyRecapPreview {
  collection: DailyRecapCollectionResult;
  presentation: DailyRecapPresentation;
}

export interface DailyRecapPreviewCollector {
  collect(guildId: string): Promise<DailyRecapCollectionResult>;
}

export class DailyRecapPreviewService {
  public constructor(private readonly collector: DailyRecapPreviewCollector) {}

  public async preview(guildId: string): Promise<DailyRecapPreview> {
    const collection = await this.collector.collect(guildId);
    const presentation = presentDailyRecap(collection);
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

    if (!hasChanges(outcome.changes)) {
      continue;
    }

    const account = {
      account: outcome.account,
      changes: outcome.changes,
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
    failures,
    linkedMembers: members,
    noActivity: members.length === 0 && watchlistAccounts.length === 0,
    watchlistAccounts,
  };
}

function hasChanges(changes: DailyRecapAccountChanges): boolean {
  return changes.skills.length > 0 || changes.bosses.length > 0;
}
