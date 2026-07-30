import type { AccountRetrievalRepository } from '../accounts/account-retrieval.js';
import type { TrackedAccount } from '../accounts/register-account.js';
import type {
  HiscoreFailure,
  HiscoreParseResult,
  HiscoreSkill,
} from '../../infrastructure/hiscores/hiscore-result.js';
import type {
  OsrsHiscoreEndpoint,
  OsrsSkillName,
} from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';
import { OSRS_MODE_FETCH_STRATEGIES } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

export interface SkillLeaderboardRequest {
  guildId: string;
  skill: OsrsSkillName;
}

export interface SkillLeaderboardEntry {
  account: TrackedAccount;
  skill: HiscoreSkill;
}

export interface SkillLeaderboardFailure {
  account: TrackedAccount;
  failure: HiscoreFailure;
}

export interface SkillLeaderboardResult {
  entries: readonly SkillLeaderboardEntry[];
  failures: readonly SkillLeaderboardFailure[];
  skill: OsrsSkillName;
}

export type SkillLeaderboardHiscoreResult =
  | HiscoreParseResult
  | Extract<HiscoreFailure, { kind: 'not_found' | 'timeout' | 'temporary_upstream_failure' }>;

export interface SkillLeaderboardHiscoreFetcher {
  fetchHiscores(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
  ): Promise<SkillLeaderboardHiscoreResult>;
}

export class SkillLeaderboardService {
  public constructor(
    private readonly accounts: Pick<AccountRetrievalRepository, 'listForGuild'>,
    private readonly hiscores: SkillLeaderboardHiscoreFetcher,
  ) {}

  public async getLeaderboard(request: SkillLeaderboardRequest): Promise<SkillLeaderboardResult> {
    const accounts = await this.accounts.listForGuild(request.guildId);
    const outcomes = await Promise.all(
      accounts.map(async (account) => this.fetchAccountSkill(account, request.skill)),
    );
    const entries: SkillLeaderboardEntry[] = [];
    const failures: SkillLeaderboardFailure[] = [];

    for (const outcome of outcomes) {
      if (outcome.kind === 'entry') {
        entries.push(outcome.entry);
      } else {
        failures.push(outcome.failure);
      }
    }

    entries.sort(compareEntries);
    return { entries, failures, skill: request.skill };
  }

  private async fetchAccountSkill(
    account: TrackedAccount,
    skillName: OsrsSkillName,
  ): Promise<
    | { kind: 'entry'; entry: SkillLeaderboardEntry }
    | { kind: 'failure'; failure: SkillLeaderboardFailure }
  > {
    const result = await this.hiscores.fetchHiscores(
      OSRS_MODE_FETCH_STRATEGIES[account.accountMode].endpoint,
      account.displayUsername,
    );
    if (result.kind !== 'success') {
      return { kind: 'failure', failure: { account, failure: result } };
    }

    const skill = result.data.skills.find((candidate) => candidate.name === skillName);
    if (skill === undefined) {
      return {
        kind: 'failure',
        failure: {
          account,
          failure: { kind: 'incomplete_response', missing: [skillName] },
        },
      };
    }
    return { kind: 'entry', entry: { account, skill } };
  }
}

function compareEntries(left: SkillLeaderboardEntry, right: SkillLeaderboardEntry): number {
  const experienceDifference = right.skill.experience - left.skill.experience;
  if (experienceDifference !== 0) {
    return experienceDifference;
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
