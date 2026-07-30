import type { AccountRetrievalRepository } from '../accounts/account-retrieval.js';
import type { TrackedAccount } from '../accounts/register-account.js';
import type {
  HiscoreFailure,
  HiscoreParseResult,
  HiscoreActivity,
} from '../../infrastructure/hiscores/hiscore-result.js';
import type {
  OsrsBossActivityName,
  OsrsHiscoreEndpoint,
} from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';
import { OSRS_MODE_FETCH_STRATEGIES } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

export interface BossLeaderboardRequest {
  boss: OsrsBossActivityName;
  guildId: string;
}

export interface BossLeaderboardEntry {
  account: TrackedAccount;
  boss: HiscoreActivity & { name: OsrsBossActivityName };
}

export interface BossLeaderboardFailure {
  account: TrackedAccount;
  failure: HiscoreFailure;
}

export interface BossLeaderboardResult {
  entries: readonly BossLeaderboardEntry[];
  failures: readonly BossLeaderboardFailure[];
  boss: OsrsBossActivityName;
}

export type BossLeaderboardHiscoreResult =
  | HiscoreParseResult
  | Extract<HiscoreFailure, { kind: 'not_found' | 'timeout' | 'temporary_upstream_failure' }>;

export interface BossLeaderboardHiscoreFetcher {
  fetchHiscores(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
  ): Promise<BossLeaderboardHiscoreResult>;
}

export class BossLeaderboardService {
  public constructor(
    private readonly accounts: Pick<AccountRetrievalRepository, 'listForGuild'>,
    private readonly hiscores: BossLeaderboardHiscoreFetcher,
  ) {}

  public async getLeaderboard(request: BossLeaderboardRequest): Promise<BossLeaderboardResult> {
    const accounts = await this.accounts.listForGuild(request.guildId);
    const outcomes = await Promise.all(
      accounts.map(async (account) => this.fetchAccountBoss(account, request.boss)),
    );
    const entries: BossLeaderboardEntry[] = [];
    const failures: BossLeaderboardFailure[] = [];

    for (const outcome of outcomes) {
      if (outcome.kind === 'entry') {
        entries.push(outcome.entry);
      } else {
        failures.push(outcome.failure);
      }
    }

    entries.sort(compareEntries);
    return {
      boss: request.boss,
      entries: omitZeroScoreEntries(entries),
      failures,
    };
  }

  private async fetchAccountBoss(
    account: TrackedAccount,
    bossName: OsrsBossActivityName,
  ): Promise<
    | { kind: 'entry'; entry: BossLeaderboardEntry }
    | { kind: 'failure'; failure: BossLeaderboardFailure }
  > {
    const result = await this.hiscores.fetchHiscores(
      OSRS_MODE_FETCH_STRATEGIES[account.accountMode].endpoint,
      account.displayUsername,
    );
    if (result.kind !== 'success') {
      return { kind: 'failure', failure: { account, failure: result } };
    }

    const boss = result.data.bosses.find((candidate) => candidate.name === bossName);
    if (boss === undefined) {
      return {
        kind: 'failure',
        failure: {
          account,
          failure: { kind: 'incomplete_response', missing: [bossName] },
        },
      };
    }
    return { kind: 'entry', entry: { account, boss } };
  }
}

function omitZeroScoreEntries(entries: readonly BossLeaderboardEntry[]): BossLeaderboardEntry[] {
  return entries.some((entry) => entry.boss.score > 0)
    ? entries.filter((entry) => entry.boss.score > 0)
    : [...entries];
}

function compareEntries(left: BossLeaderboardEntry, right: BossLeaderboardEntry): number {
  const scoreDifference = right.boss.score - left.boss.score;
  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  const usernameComparison = left.account.normalizedUsername.localeCompare(
    right.account.normalizedUsername,
    'en-US',
  );
  if (usernameComparison !== 0) {
    return usernameComparison;
  }
  return left.account.id.localeCompare(right.account.id, 'en-US');
}
