import type { AccountRetrievalRepository } from '../accounts/account-retrieval.js';
import type { TrackedAccount } from '../accounts/register-account.js';
import type {
  HiscoreActivity,
  HiscoreFailure,
  HiscoreParseResult,
} from '../../infrastructure/hiscores/hiscore-result.js';
import type {
  OsrsAccountMode,
  OsrsBossActivityName,
  OsrsHiscoreEndpoint,
} from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';
import { OSRS_MODE_FETCH_STRATEGIES } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

export type BossLookupTarget =
  | { kind: 'default_account' }
  | { kind: 'tracked_account'; accountId: string }
  | { kind: 'one_time_account'; accountMode: OsrsAccountMode; username: string };

export interface BossLookupRequest {
  boss: OsrsBossActivityName;
  guildId: string;
  requesterDiscordUserId: string;
  target: BossLookupTarget;
}

export type ResolvedBossLookupTarget =
  | { kind: 'tracked_account'; account: TrackedAccount }
  | {
      kind: 'one_time_account';
      accountMode: OsrsAccountMode;
      displayUsername: string;
    };

export type BossLookupResult =
  | {
      kind: 'found';
      boss: HiscoreActivity & { name: OsrsBossActivityName };
      target: ResolvedBossLookupTarget;
    }
  | { kind: 'default_account_not_found' }
  | { kind: 'account_not_found' }
  | { kind: 'hiscores_failure'; failure: HiscoreFailure; target: ResolvedBossLookupTarget };

export type BossLookupHiscoreResult =
  | HiscoreParseResult
  | Extract<HiscoreFailure, { kind: 'not_found' | 'timeout' | 'temporary_upstream_failure' }>;

export interface BossLookupHiscoreFetcher {
  fetchHiscores(endpoint: OsrsHiscoreEndpoint, username: string): Promise<BossLookupHiscoreResult>;
}

export class BossLookupService {
  public constructor(
    private readonly accounts: Pick<AccountRetrievalRepository, 'getById' | 'getDefaultForMember'>,
    private readonly hiscores: BossLookupHiscoreFetcher,
  ) {}

  public async lookup(request: BossLookupRequest): Promise<BossLookupResult> {
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

    const boss = result.data.bosses.find((candidate) => candidate.name === request.boss);
    if (boss === undefined) {
      return {
        kind: 'hiscores_failure',
        failure: { kind: 'incomplete_response', missing: [request.boss] },
        target: target.resolved,
      };
    }

    return {
      boss,
      kind: 'found',
      target: successTarget(target.resolved, result.data.returnedName),
    };
  }

  private async resolveTarget(request: BossLookupRequest): Promise<
    | { kind: 'default_account_not_found' }
    | { kind: 'account_not_found' }
    | {
        kind: 'resolved';
        accountMode: OsrsAccountMode;
        resolved: ResolvedBossLookupTarget;
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
          accountMode: request.target.accountMode,
          kind: 'resolved',
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
  target: ResolvedBossLookupTarget,
  returnedName: string,
): ResolvedBossLookupTarget {
  if (target.kind === 'tracked_account') {
    return target;
  }
  return { ...target, displayUsername: returnedName };
}

function trackedTarget(account: TrackedAccount): {
  kind: 'resolved';
  accountMode: OsrsAccountMode;
  resolved: ResolvedBossLookupTarget;
  username: string;
} {
  return {
    accountMode: account.accountMode,
    kind: 'resolved',
    resolved: { account, kind: 'tracked_account' },
    username: account.displayUsername,
  };
}
