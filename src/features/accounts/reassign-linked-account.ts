import type { TrackedAccount } from './register-account.js';

export interface ReassignLinkedAccountRequest {
  accountId: string;
  canManageAccounts: boolean;
  guildId: string;
  requesterDiscordUserId: string;
  targetDiscordUserId: string;
}

export type ReassignLinkedAccountResult =
  | { kind: 'reassigned'; account: TrackedAccount }
  | { kind: 'forbidden' }
  | { kind: 'account_not_found' }
  | { kind: 'account_not_linked' }
  | { kind: 'reassignment_unchanged' }
  | { kind: 'account_limit_reached' };

export interface LinkedAccountReassignmentRepository {
  reassignLinkedAccount(
    request: ReassignLinkedAccountRequest,
  ): Promise<ReassignLinkedAccountResult>;
}

export class LinkedAccountReassignmentService {
  public constructor(private readonly repository: LinkedAccountReassignmentRepository) {}

  public reassign(request: ReassignLinkedAccountRequest): Promise<ReassignLinkedAccountResult> {
    return this.repository.reassignLinkedAccount(request);
  }
}

export function canReassignLinkedAccount(
  account: TrackedAccount,
  request: ReassignLinkedAccountRequest,
): boolean {
  return request.canManageAccounts && account.association.type === 'linked';
}
