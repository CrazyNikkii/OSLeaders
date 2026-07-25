import type { AccountRetrievalRepository } from './account-retrieval.js';
import type { TrackedAccount } from './register-account.js';

export interface SelectDefaultAccountRequest {
  accountId: string;
  canManageAccounts: boolean;
  guildId: string;
  requesterDiscordUserId: string;
}

export type SelectDefaultAccountResult =
  | { kind: 'selected'; account: TrackedAccount }
  | { kind: 'forbidden' }
  | { kind: 'account_not_found' };

export interface DefaultAccountSelectionRepository {
  selectDefault(
    guildId: string,
    discordUserId: string,
    accountId: string,
  ): Promise<TrackedAccount | undefined>;
}

export class DefaultAccountSelectionService {
  public constructor(
    private readonly accounts: AccountRetrievalRepository,
    private readonly repository: DefaultAccountSelectionRepository,
  ) {}

  public async select(request: SelectDefaultAccountRequest): Promise<SelectDefaultAccountResult> {
    const account = await this.accounts.getById(request.guildId, request.accountId);
    if (account?.association.type !== 'linked') {
      return { kind: 'account_not_found' };
    }
    if (
      account.association.discordUserId !== request.requesterDiscordUserId &&
      !request.canManageAccounts
    ) {
      return { kind: 'forbidden' };
    }

    const selected = await this.repository.selectDefault(
      request.guildId,
      account.association.discordUserId,
      account.id,
    );
    return selected === undefined
      ? { kind: 'account_not_found' }
      : { kind: 'selected', account: selected };
  }
}
