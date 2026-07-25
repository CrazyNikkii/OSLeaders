import type { AccountRetrievalRepository } from './account-retrieval.js';
import type { AccountModeValidationService, TrackedAccount } from './register-account.js';
import type { HiscoreResult } from '../../infrastructure/hiscores/hiscore-result.js';
import type { OsrsAccountMode } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

export interface ChangeAccountModeRequest {
  accountId: string;
  accountMode: OsrsAccountMode;
  canManageAccounts: boolean;
  guildId: string;
  requesterDiscordUserId: string;
}

export type ChangeAccountModeResult =
  | { kind: 'mode_changed'; account: TrackedAccount }
  | { kind: 'forbidden' }
  | { kind: 'account_not_found' }
  | { kind: 'hiscores_failure'; failure: Exclude<HiscoreResult, { kind: 'success' }> };

export interface AccountModeChangeRepository {
  changeMode(
    guildId: string,
    accountId: string,
    accountMode: OsrsAccountMode,
  ): Promise<{ kind: 'mode_changed'; account: TrackedAccount } | { kind: 'account_not_found' }>;
}

export class AccountModeChangeService {
  public constructor(
    private readonly accountModeValidator: AccountModeValidationService,
    private readonly accounts: AccountRetrievalRepository,
    private readonly repository: AccountModeChangeRepository,
  ) {}

  public async change(request: ChangeAccountModeRequest): Promise<ChangeAccountModeResult> {
    const account = await this.accounts.getById(request.guildId, request.accountId);
    if (account === undefined) {
      return { kind: 'account_not_found' };
    }
    if (!canChangeMode(account, request)) {
      return { kind: 'forbidden' };
    }

    const validation = await this.accountModeValidator.validate({
      accountMode: request.accountMode,
      username: account.displayUsername,
    });
    if (validation.kind !== 'success') {
      return { kind: 'hiscores_failure', failure: validation };
    }

    return this.repository.changeMode(request.guildId, account.id, request.accountMode);
  }
}

function canChangeMode(account: TrackedAccount, request: ChangeAccountModeRequest): boolean {
  if (request.canManageAccounts) {
    return true;
  }
  if (account.association.type === 'linked') {
    return account.association.discordUserId === request.requesterDiscordUserId;
  }
  return account.registeredByDiscordUserId === request.requesterDiscordUserId;
}
