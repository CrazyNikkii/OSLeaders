import type { TrackedAccount } from './register-account.js';

export interface RemoveAccountRequest {
  accountId: string;
  canManageAccounts: boolean;
  guildId: string;
  requesterDiscordUserId: string;
}

export type RemoveAccountResult =
  | { kind: 'removed'; account: TrackedAccount; replacementDefaultAccount?: TrackedAccount }
  | { kind: 'active_competition_locked' }
  | { kind: 'forbidden' }
  | { kind: 'account_not_found' };

export interface AccountRemovalRepository {
  removeAccount(request: RemoveAccountRequest): Promise<RemoveAccountResult>;
}

export class AccountRemovalService {
  public constructor(private readonly repository: AccountRemovalRepository) {}

  public remove(request: RemoveAccountRequest): Promise<RemoveAccountResult> {
    return this.repository.removeAccount(request);
  }
}

export function canRemoveAccount(account: TrackedAccount, request: RemoveAccountRequest): boolean {
  if (request.canManageAccounts) {
    return true;
  }
  if (account.association.type === 'linked') {
    return account.association.discordUserId === request.requesterDiscordUserId;
  }
  return account.registeredByDiscordUserId === request.requesterDiscordUserId;
}
