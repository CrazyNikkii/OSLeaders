import type { AccountAssociation, TrackedAccount } from './register-account.js';

export interface ConvertAccountAssociationRequest {
  accountId: string;
  canManageAccounts: boolean;
  guildId: string;
  requesterDiscordUserId: string;
  targetAssociation: AccountAssociation;
}

export type ConvertAccountAssociationResult =
  | { kind: 'converted'; account: TrackedAccount }
  | { kind: 'forbidden' }
  | { kind: 'account_not_found' }
  | { kind: 'association_unchanged' }
  | { kind: 'account_limit_reached' };

export interface AccountAssociationConversionRepository {
  convertAssociation(
    request: ConvertAccountAssociationRequest,
  ): Promise<
    | { kind: 'converted'; account: TrackedAccount }
    | { kind: 'forbidden' }
    | { kind: 'account_not_found' }
    | { kind: 'association_unchanged' }
    | { kind: 'account_limit_reached' }
  >;
}

export class AccountAssociationConversionService {
  public constructor(private readonly repository: AccountAssociationConversionRepository) {}

  public async convert(
    request: ConvertAccountAssociationRequest,
  ): Promise<ConvertAccountAssociationResult> {
    return this.repository.convertAssociation(request);
  }
}

export function canConvertAccountAssociation(
  account: TrackedAccount,
  request: ConvertAccountAssociationRequest,
): boolean {
  if (account.association.type === 'watchlist') {
    return request.canManageAccounts && request.targetAssociation.type === 'linked';
  }
  return (
    request.targetAssociation.type === 'watchlist' &&
    (request.canManageAccounts ||
      account.association.discordUserId === request.requesterDiscordUserId)
  );
}
