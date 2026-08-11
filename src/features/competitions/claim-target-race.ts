import type {
  HiscoreFailure,
  HiscoreParseResult,
} from '../../infrastructure/hiscores/hiscore-result.js';
import type { OsrsHiscoreEndpoint } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';
import { OSRS_MODE_FETCH_STRATEGIES } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

import type { CompetitionMetric } from './create-competition.js';

export interface TargetRaceClaimAccount {
  accountMode: keyof typeof OSRS_MODE_FETCH_STRATEGIES;
  displayUsername: string;
  id: string;
  startingValue: bigint;
}

export interface TargetRaceClaimReady {
  accounts: readonly TargetRaceClaimAccount[];
  claimId: string;
  competitionId: string;
  entrantId: string;
  guildId: string;
  metric: CompetitionMetric;
  receivedAt: Date;
  targetValue: bigint;
}

export interface TargetRaceClaimRepository {
  beginClaim(request: {
    canManageCompetitions: boolean;
    claimId: string;
    competitionId: string;
    entrantId: string;
    guildId: string;
    receivedAt: Date;
    requesterDiscordUserId: string;
  }): Promise<TargetRaceClaimBeginResult>;
  prepareRetry(request: {
    canManageCompetitions: boolean;
    claimId: string;
    guildId: string;
    requesterDiscordUserId: string;
  }): Promise<TargetRaceClaimBeginResult>;
  claimDueRetry(): Promise<TargetRaceClaimReady | undefined>;
  recordTemporaryFailure(request: {
    claimId: string;
    failureSummary: string;
    guildId: string;
  }): Promise<void>;
  recordVerificationFailure(request: {
    claimId: string;
    failureSummary: string;
    guildId: string;
  }): Promise<void>;
  finalize(request: {
    claimId: string;
    finalValues: readonly { accountId: string; value: bigint }[];
    guildId: string;
    verifiedAt: Date;
  }): Promise<TargetRaceClaimFinalizeResult>;
}

export type TargetRaceClaimBeginResult =
  | { kind: 'ready'; claim: TargetRaceClaimReady }
  | {
      kind:
        | 'competition_not_found'
        | 'not_target_race'
        | 'not_active'
        | 'forbidden'
        | 'entrant_not_found'
        | 'deadline_passed'
        | 'claim_not_found'
        | 'claim_not_retryable';
    };

export type TargetRaceClaimFinalizeResult =
  | { kind: 'won'; claimId: string; finalValue: bigint; verifiedAt: Date }
  | { kind: 'target_not_reached'; finalValue: bigint; targetValue: bigint }
  | { kind: 'earlier_claim_pending' }
  | { kind: 'claim_not_active' };

export interface TargetRaceClaimPermissionEvaluator {
  evaluate(request: {
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
  }): Promise<{ canManageCompetitions: boolean }>;
}

export type TargetRaceClaimHiscoreResult =
  | HiscoreParseResult
  | Extract<HiscoreFailure, { kind: 'not_found' | 'timeout' | 'temporary_upstream_failure' }>;

export interface TargetRaceClaimHiscoreFetcher {
  fetchHiscores(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
    options: { cacheMode: 'bypass' },
  ): Promise<TargetRaceClaimHiscoreResult>;
}

export type TargetRaceClaimResult =
  | TargetRaceClaimFinalizeResult
  | Exclude<TargetRaceClaimBeginResult, { kind: 'ready' }>
  | { kind: 'verification_failed'; claimId: string; failures: readonly HiscoreFailure[] }
  | { kind: 'verification_pending'; claimId: string; failures: readonly HiscoreFailure[] };

export class TargetRaceClaimService {
  public constructor(
    private readonly repository: TargetRaceClaimRepository,
    private readonly permissions: TargetRaceClaimPermissionEvaluator,
    private readonly hiscores: TargetRaceClaimHiscoreFetcher,
    private readonly createId: () => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async claim(request: {
    competitionId: string;
    entrantId: string;
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
    requesterIsPresent: boolean;
  }): Promise<TargetRaceClaimResult> {
    if (!request.requesterIsPresent) return { kind: 'forbidden' };
    const permissions = await this.permissions.evaluate(request);
    const begin = await this.repository.beginClaim({
      canManageCompetitions: permissions.canManageCompetitions,
      claimId: this.createId(),
      competitionId: request.competitionId,
      entrantId: request.entrantId,
      guildId: request.guildId,
      receivedAt: this.now(),
      requesterDiscordUserId: request.requesterDiscordUserId,
    });
    return begin.kind === 'ready' ? this.verify(begin.claim) : begin;
  }

  public async retry(request: {
    claimId: string;
    guildId: string;
    hasAdministratorPermission: boolean;
    memberRoleIds: readonly string[];
    requesterDiscordUserId: string;
    requesterIsPresent: boolean;
  }): Promise<TargetRaceClaimResult> {
    if (!request.requesterIsPresent) return { kind: 'forbidden' };
    const permissions = await this.permissions.evaluate(request);
    const begin = await this.repository.prepareRetry({
      canManageCompetitions: permissions.canManageCompetitions,
      claimId: request.claimId,
      guildId: request.guildId,
      requesterDiscordUserId: request.requesterDiscordUserId,
    });
    return begin.kind === 'ready' ? this.verify(begin.claim) : begin;
  }

  public async retryDue(): Promise<TargetRaceClaimResult | { kind: 'no_due_claim' }> {
    const claim = await this.repository.claimDueRetry();
    return claim === undefined ? { kind: 'no_due_claim' } : this.verify(claim);
  }

  private async verify(claim: TargetRaceClaimReady): Promise<TargetRaceClaimResult> {
    const outcomes = await Promise.all(
      claim.accounts.map((account) => this.fetchValue(account, claim.metric)),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.kind === 'failure' ? [outcome.failure] : [],
    );
    const failureSummary = failures
      .map((failure) => failure.kind)
      .join(', ')
      .slice(0, 500);
    if (failures.some(isPermanentFailure)) {
      await this.repository.recordVerificationFailure({
        claimId: claim.claimId,
        failureSummary,
        guildId: claim.guildId,
      });
      return { kind: 'verification_failed', claimId: claim.claimId, failures };
    }
    if (failures.length > 0) {
      await this.repository.recordTemporaryFailure({
        claimId: claim.claimId,
        failureSummary,
        guildId: claim.guildId,
      });
      return { kind: 'verification_pending', claimId: claim.claimId, failures };
    }
    return this.repository.finalize({
      claimId: claim.claimId,
      finalValues: outcomes.map((outcome) => {
        if (outcome.kind !== 'success')
          throw new Error('Successful verification must have values.');
        return { accountId: outcome.account.id, value: outcome.value };
      }),
      guildId: claim.guildId,
      verifiedAt: this.now(),
    });
  }

  private async fetchValue(
    account: TargetRaceClaimAccount,
    metric: CompetitionMetric,
  ): Promise<
    | { account: TargetRaceClaimAccount; kind: 'success'; value: bigint }
    | { account: TargetRaceClaimAccount; failure: HiscoreFailure; kind: 'failure' }
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

function isPermanentFailure(failure: HiscoreFailure): boolean {
  return failure.kind === 'not_found' || failure.kind === 'incomplete_response';
}
