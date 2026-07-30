import type { AccountRetrievalRepository } from './account-retrieval.js';
import {
  normalizeOsrsUsername,
  type AccountModeValidationService,
  type TrackedAccount,
} from './register-account.js';
import type { HiscoreResult } from '../../infrastructure/hiscores/hiscore-result.js';

export interface RenameAccountRequest {
  accountId: string;
  canManageAccounts: boolean;
  guildId: string;
  requesterDiscordUserId: string;
  username: string;
}

export type RenameAccountResult =
  | { kind: 'renamed'; account: TrackedAccount; previousDisplayUsername: string }
  | { kind: 'forbidden' }
  | { kind: 'account_not_found' }
  | { kind: 'invalid_username' }
  | { kind: 'username_taken' }
  | { kind: 'hiscores_failure'; failure: Exclude<HiscoreResult, { kind: 'success' }> };

export interface AccountRenameRepository {
  rename(
    guildId: string,
    accountId: string,
    username: { displayUsername: string; normalizedUsername: string },
  ): Promise<
    | { kind: 'renamed'; account: TrackedAccount }
    | { kind: 'account_not_found' }
    | { kind: 'username_taken' }
  >;
}

export class AccountRenameService {
  public constructor(
    private readonly accountModeValidator: AccountModeValidationService,
    private readonly accounts: AccountRetrievalRepository,
    private readonly repository: AccountRenameRepository,
  ) {}

  public async rename(request: RenameAccountRequest): Promise<RenameAccountResult> {
    const account = await this.accounts.getById(request.guildId, request.accountId);
    if (account === undefined) {
      return { kind: 'account_not_found' };
    }
    if (!canRename(account, request)) {
      return { kind: 'forbidden' };
    }
    const previousDisplayUsername = account.displayUsername;

    const validation = await this.accountModeValidator.validate({
      accountMode: account.accountMode,
      username: request.username,
    });
    if (validation.kind !== 'success') {
      return { kind: 'hiscores_failure', failure: validation };
    }

    const displayUsername = validation.data.returnedName;
    const normalizedUsername = normalizeOsrsUsername(displayUsername);
    if (normalizedUsername.length === 0) {
      return { kind: 'invalid_username' };
    }

    const result = await this.repository.rename(request.guildId, account.id, {
      displayUsername,
      normalizedUsername,
    });
    return result.kind === 'renamed' ? { ...result, previousDisplayUsername } : result;
  }
}

export function canRename(account: TrackedAccount, request: RenameAccountRequest): boolean {
  if (request.canManageAccounts) {
    return true;
  }
  if (account.association.type === 'linked') {
    return account.association.discordUserId === request.requesterDiscordUserId;
  }
  return account.registeredByDiscordUserId === request.requesterDiscordUserId;
}
