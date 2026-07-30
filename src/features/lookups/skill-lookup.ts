import type { AccountRetrievalRepository } from '../accounts/account-retrieval.js';
import type { TrackedAccount } from '../accounts/register-account.js';
import type {
  HiscoreFailure,
  HiscoreParseResult,
  HiscoreSkill,
} from '../../infrastructure/hiscores/hiscore-result.js';
import type {
  OsrsAccountMode,
  OsrsHiscoreEndpoint,
  OsrsSkillName,
} from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';
import { OSRS_MODE_FETCH_STRATEGIES } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

export type SkillLookupTarget =
  | { kind: 'default_account' }
  | { kind: 'tracked_account'; accountId: string }
  | { kind: 'one_time_account'; accountMode: OsrsAccountMode; username: string };

export interface SkillLookupRequest {
  guildId: string;
  requesterDiscordUserId: string;
  skill: OsrsSkillName;
  target: SkillLookupTarget;
}

export type ResolvedSkillLookupTarget =
  | { kind: 'tracked_account'; account: TrackedAccount }
  | {
      kind: 'one_time_account';
      accountMode: OsrsAccountMode;
      displayUsername: string;
    };

export type SkillLookupResult =
  | { kind: 'found'; skill: HiscoreSkill; target: ResolvedSkillLookupTarget }
  | { kind: 'default_account_not_found' }
  | { kind: 'account_not_found' }
  | { kind: 'hiscores_failure'; failure: HiscoreFailure; target: ResolvedSkillLookupTarget };

export type SkillLookupHiscoreResult =
  | HiscoreParseResult
  | Extract<HiscoreFailure, { kind: 'not_found' | 'timeout' | 'temporary_upstream_failure' }>;

export interface SkillLookupHiscoreFetcher {
  fetchHiscores(endpoint: OsrsHiscoreEndpoint, username: string): Promise<SkillLookupHiscoreResult>;
}

export class SkillLookupService {
  public constructor(
    private readonly accounts: Pick<AccountRetrievalRepository, 'getById' | 'getDefaultForMember'>,
    private readonly hiscores: SkillLookupHiscoreFetcher,
  ) {}

  public async lookup(request: SkillLookupRequest): Promise<SkillLookupResult> {
    const target = await this.resolveTarget(request);
    if (target.kind !== 'resolved') {
      return target;
    }

    const result = await this.hiscores.fetchHiscores(
      OSRS_MODE_FETCH_STRATEGIES[target.accountMode].endpoint,
      target.username,
    );
    if (result.kind !== 'success') {
      return { kind: 'hiscores_failure', failure: result, target: target.resolved };
    }

    const skill = result.data.skills.find((candidate) => candidate.name === request.skill);
    if (skill === undefined) {
      return {
        kind: 'hiscores_failure',
        failure: { kind: 'incomplete_response', missing: [request.skill] },
        target: target.resolved,
      };
    }

    return {
      kind: 'found',
      skill,
      target: successTarget(target.resolved, result.data.returnedName),
    };
  }

  private async resolveTarget(request: SkillLookupRequest): Promise<
    | { kind: 'default_account_not_found' }
    | { kind: 'account_not_found' }
    | {
        kind: 'resolved';
        accountMode: OsrsAccountMode;
        resolved: ResolvedSkillLookupTarget;
        username: string;
      }
  > {
    switch (request.target.kind) {
      case 'default_account': {
        const account = await this.accounts.getDefaultForMember(
          request.guildId,
          request.requesterDiscordUserId,
        );
        if (account === undefined) {
          return { kind: 'default_account_not_found' };
        }
        return trackedTarget(account);
      }
      case 'tracked_account': {
        const account = await this.accounts.getById(request.guildId, request.target.accountId);
        if (account === undefined) {
          return { kind: 'account_not_found' };
        }
        return trackedTarget(account);
      }
      case 'one_time_account':
        return {
          kind: 'resolved',
          accountMode: request.target.accountMode,
          resolved: {
            accountMode: request.target.accountMode,
            displayUsername: request.target.username,
            kind: 'one_time_account',
          },
          username: request.target.username,
        };
    }
  }
}

function successTarget(
  target: ResolvedSkillLookupTarget,
  returnedName: string,
): ResolvedSkillLookupTarget {
  if (target.kind === 'tracked_account') {
    return target;
  }
  return { ...target, displayUsername: returnedName };
}

function trackedTarget(account: TrackedAccount): {
  kind: 'resolved';
  accountMode: OsrsAccountMode;
  resolved: ResolvedSkillLookupTarget;
  username: string;
} {
  return {
    kind: 'resolved',
    accountMode: account.accountMode,
    resolved: { account, kind: 'tracked_account' },
    username: account.displayUsername,
  };
}
