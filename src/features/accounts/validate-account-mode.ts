import type {
  HiscoreParseResult,
  HiscoreResult,
} from '../../infrastructure/hiscores/hiscore-result.js';
import type {
  OsrsAccountMode,
  OsrsHiscoreEndpoint,
  OsrsModeFetchStrategy,
} from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

type AccountModeValidationFailure = Exclude<HiscoreResult, { kind: 'success' }>;
type AccountModeValidationFetchResult = HiscoreParseResult | AccountModeValidationFailure;

export interface AccountModeHiscoreFetcher {
  fetchHiscores(
    endpoint: OsrsHiscoreEndpoint,
    username: string,
  ): Promise<AccountModeValidationFetchResult>;
}

export interface AccountModeValidationRequest {
  accountMode: OsrsAccountMode;
  username: string;
}

export class AccountModeValidator {
  public constructor(
    private readonly fetcher: AccountModeHiscoreFetcher,
    private readonly modeFetchStrategies: Readonly<Record<OsrsAccountMode, OsrsModeFetchStrategy>>,
  ) {}

  public async validate({
    accountMode,
    username,
  }: AccountModeValidationRequest): Promise<HiscoreResult> {
    const strategy = this.modeFetchStrategies[accountMode];
    const primaryResult = await this.fetcher.fetchHiscores(strategy.endpoint, username);
    if (primaryResult.kind !== 'success') {
      return primaryResult;
    }

    if (strategy.verification === 'requires_specific_mode_exclusion') {
      const regularIronmanResult = await this.validateRegularIronman(username);
      if (regularIronmanResult !== undefined) {
        return regularIronmanResult;
      }
    }

    return {
      kind: 'success',
      accountMode,
      data: primaryResult.data,
      endpoint: strategy.endpoint,
      modeVerification:
        strategy.verification === 'server_managed' ? 'server_managed' : 'endpoint_verified',
    };
  }

  private async validateRegularIronman(
    username: string,
  ): Promise<AccountModeValidationFailure | undefined> {
    const hardcoreResult = await this.fetcher.fetchHiscores(
      this.modeFetchStrategies.hardcore_ironman.endpoint,
      username,
    );
    if (hardcoreResult.kind === 'success') {
      return { kind: 'mode_incompatible' };
    }
    if (hardcoreResult.kind !== 'not_found') {
      return hardcoreResult;
    }

    const ultimateResult = await this.fetcher.fetchHiscores(
      this.modeFetchStrategies.ultimate_ironman.endpoint,
      username,
    );
    if (ultimateResult.kind === 'success') {
      return { kind: 'mode_incompatible' };
    }
    if (ultimateResult.kind !== 'not_found') {
      return ultimateResult;
    }

    return undefined;
  }
}
