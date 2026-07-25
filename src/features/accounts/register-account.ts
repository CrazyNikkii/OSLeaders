import { randomUUID } from 'node:crypto';

import type { HiscoreResult } from '../../infrastructure/hiscores/hiscore-result.js';
import type { OsrsAccountMode } from '../../infrastructure/hiscores/osrs-hiscore-catalog.js';

export const MAX_TRACKED_ACCOUNTS_PER_MEMBER = 10;

export type AccountAssociation = { type: 'linked'; discordUserId: string } | { type: 'watchlist' };

export interface RegisterAccountRequest {
  accountMode: OsrsAccountMode;
  association: AccountAssociation;
  canManageAccounts: boolean;
  guildId: string;
  requesterDiscordUserId: string;
  username: string;
}

export interface TrackedAccount {
  accountMode: OsrsAccountMode;
  association: AccountAssociation;
  createdAt: Date;
  displayUsername: string;
  guildId: string;
  id: string;
  isDefault: boolean;
  normalizedUsername: string;
  quotaOwnerDiscordUserId: string;
  registeredByDiscordUserId: string;
}

export interface InitialRecapBaseline {
  bossKillCounts: Record<string, number>;
  capturedAt: Date;
  skillExperience: Record<string, number>;
  skillLevels: Record<string, number>;
}

export type AccountRegistrationResult =
  | { kind: 'registered'; account: TrackedAccount }
  | { kind: 'forbidden' }
  | { kind: 'invalid_username' }
  | { kind: 'username_taken' }
  | { kind: 'account_limit_reached' }
  | { kind: 'hiscores_failure'; failure: Exclude<HiscoreResult, { kind: 'success' }> };

export interface AccountModeValidationService {
  validate(request: { accountMode: OsrsAccountMode; username: string }): Promise<HiscoreResult>;
}

export interface AccountRegistrationRepository {
  register(
    account: Omit<TrackedAccount, 'createdAt' | 'isDefault'>,
    initialRecapBaseline: InitialRecapBaseline,
  ): Promise<
    | { kind: 'registered'; account: TrackedAccount }
    | { kind: 'username_taken' }
    | { kind: 'account_limit_reached' }
  >;
}

export class AccountRegistrationService {
  public constructor(
    private readonly accountModeValidator: AccountModeValidationService,
    private readonly repository: AccountRegistrationRepository,
  ) {}

  public async register(request: RegisterAccountRequest): Promise<AccountRegistrationResult> {
    const association = resolveAssociation(request);
    if (association === undefined) {
      return { kind: 'forbidden' };
    }

    const validation = await this.accountModeValidator.validate({
      accountMode: request.accountMode,
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

    const quotaOwnerDiscordUserId =
      association.type === 'linked' ? association.discordUserId : request.requesterDiscordUserId;

    return this.repository.register(
      {
        accountMode: request.accountMode,
        association,
        displayUsername,
        guildId: request.guildId,
        id: randomUUID(),
        normalizedUsername,
        quotaOwnerDiscordUserId,
        registeredByDiscordUserId: request.requesterDiscordUserId,
      },
      toInitialRecapBaseline(validation.data),
    );
  }
}

function toInitialRecapBaseline(
  data: Extract<HiscoreResult, { kind: 'success' }>['data'],
): InitialRecapBaseline {
  return {
    bossKillCounts: Object.fromEntries(data.bosses.map(({ name, score }) => [name, score])),
    capturedAt: new Date(),
    skillExperience: Object.fromEntries(
      data.skills.map(({ name, experience }) => [name, experience]),
    ),
    skillLevels: Object.fromEntries(data.skills.map(({ name, level }) => [name, level])),
  };
}

export function normalizeOsrsUsername(username: string): string {
  return username.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function resolveAssociation(request: RegisterAccountRequest): AccountAssociation | undefined {
  if (request.association.type === 'watchlist') {
    return request.association;
  }

  if (
    request.association.discordUserId !== request.requesterDiscordUserId &&
    !request.canManageAccounts
  ) {
    return undefined;
  }

  return request.association;
}
