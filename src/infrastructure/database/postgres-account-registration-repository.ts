import { and, asc, count, eq, ne, notInArray, sql } from 'drizzle-orm';

import type { AccountRetrievalRepository } from '../../features/accounts/account-retrieval.js';
import type { AccountModeChangeRepository } from '../../features/accounts/change-account-mode.js';
import {
  canConvertAccountAssociation,
  type AccountAssociationConversionRepository,
  type ConvertAccountAssociationRequest,
} from '../../features/accounts/convert-account-association.js';
import type { DefaultAccountSelectionRepository } from '../../features/accounts/select-default-account.js';
import type {
  GuildMemberPresence,
  MemberPresenceRepository,
} from '../../features/accounts/member-presence.js';
import type { AccountRenameRepository } from '../../features/accounts/rename-account.js';
import {
  canRemoveAccount,
  type AccountRemovalRepository,
  type RemoveAccountRequest,
  type RemoveAccountResult,
} from '../../features/accounts/remove-account.js';
import {
  canReassignLinkedAccount,
  type LinkedAccountReassignmentRepository,
  type ReassignLinkedAccountRequest,
  type ReassignLinkedAccountResult,
} from '../../features/accounts/reassign-linked-account.js';
import {
  MAX_TRACKED_ACCOUNTS_PER_MEMBER,
  type AccountRegistrationRepository,
  type InitialRecapBaseline,
  type TrackedAccount,
} from '../../features/accounts/register-account.js';
import type { OsrsAccountMode } from '../hiscores/osrs-hiscore-catalog.js';
import type { Database, Transaction } from './connection.js';
import {
  competitionContributingAccounts,
  competitions,
  guildMemberPresences,
  guilds,
  recapBaselines,
  trackedAccounts,
} from './schema/index.js';

export class PostgresAccountRegistrationRepository
  implements
    AccountRegistrationRepository,
    AccountRetrievalRepository,
    DefaultAccountSelectionRepository,
    AccountModeChangeRepository,
    AccountRenameRepository,
    AccountRemovalRepository,
    AccountAssociationConversionRepository,
    LinkedAccountReassignmentRepository,
    MemberPresenceRepository
{
  public constructor(private readonly database: Database) {}

  public register(
    account: Omit<TrackedAccount, 'createdAt' | 'isDefault'>,
    initialRecapBaseline: InitialRecapBaseline,
  ): Promise<
    | { kind: 'registered'; account: TrackedAccount }
    | { kind: 'username_taken' }
    | { kind: 'account_limit_reached' }
  > {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${account.guildId}, 0))`,
      );
      await transaction.insert(guilds).values({ guildId: account.guildId }).onConflictDoNothing();

      const existing = await this.findByNormalizedUsername(
        transaction,
        account.guildId,
        account.normalizedUsername,
      );
      if (existing !== undefined) {
        return { kind: 'username_taken' };
      }

      const [countResult] = await transaction
        .select({ accountCount: count() })
        .from(trackedAccounts)
        .where(
          and(
            eq(trackedAccounts.guildId, account.guildId),
            eq(trackedAccounts.quotaOwnerDiscordUserId, account.quotaOwnerDiscordUserId),
          ),
        );
      if (countResult === undefined) {
        throw new Error('Account quota count was not returned.');
      }
      if (countResult.accountCount >= MAX_TRACKED_ACCOUNTS_PER_MEMBER) {
        return { kind: 'account_limit_reached' };
      }

      const isDefault =
        account.association.type === 'linked' &&
        !(await this.hasLinkedAccount(
          transaction,
          account.guildId,
          account.association.discordUserId,
        ));
      const [stored] = await transaction
        .insert(trackedAccounts)
        .values({
          accountMode: account.accountMode,
          associationType: account.association.type,
          displayUsername: account.displayUsername,
          guildId: account.guildId,
          id: account.id,
          isDefault,
          linkedDiscordUserId:
            account.association.type === 'linked' ? account.association.discordUserId : null,
          normalizedUsername: account.normalizedUsername,
          quotaOwnerDiscordUserId: account.quotaOwnerDiscordUserId,
          registeredByDiscordUserId: account.registeredByDiscordUserId,
        })
        .returning();

      if (stored === undefined) {
        throw new Error('Tracked account was not created.');
      }
      await transaction.insert(recapBaselines).values({
        accountId: stored.id,
        bossKillCounts: initialRecapBaseline.bossKillCounts,
        capturedAt: initialRecapBaseline.capturedAt,
        guildId: account.guildId,
        skillExperience: initialRecapBaseline.skillExperience,
        skillLevels: initialRecapBaseline.skillLevels,
      });

      return { kind: 'registered', account: toTrackedAccount(stored) };
    });
  }

  public async getById(guildId: string, accountId: string): Promise<TrackedAccount | undefined> {
    const [account] = await this.database
      .select()
      .from(trackedAccounts)
      .where(and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, accountId)));
    return account === undefined ? undefined : toTrackedAccount(account);
  }

  public async getDefaultForMember(
    guildId: string,
    discordUserId: string,
  ): Promise<TrackedAccount | undefined> {
    const [account] = await this.database
      .select()
      .from(trackedAccounts)
      .where(
        and(
          eq(trackedAccounts.guildId, guildId),
          eq(trackedAccounts.linkedDiscordUserId, discordUserId),
          eq(trackedAccounts.isDefault, true),
        ),
      );
    return account === undefined ? undefined : toTrackedAccount(account);
  }

  public async listForGuild(guildId: string): Promise<TrackedAccount[]> {
    const accounts = await this.database
      .select()
      .from(trackedAccounts)
      .where(eq(trackedAccounts.guildId, guildId))
      .orderBy(asc(trackedAccounts.createdAt), asc(trackedAccounts.id));
    return accounts.map(toTrackedAccount);
  }

  public async listLinkedForMember(
    guildId: string,
    discordUserId: string,
  ): Promise<TrackedAccount[]> {
    const accounts = await this.database
      .select()
      .from(trackedAccounts)
      .where(
        and(
          eq(trackedAccounts.guildId, guildId),
          eq(trackedAccounts.linkedDiscordUserId, discordUserId),
        ),
      )
      .orderBy(asc(trackedAccounts.createdAt), asc(trackedAccounts.id));
    return accounts.map(toTrackedAccount);
  }

  public async getMemberPresence(
    guildId: string,
    discordUserId: string,
  ): Promise<GuildMemberPresence | undefined> {
    const [presence] = await this.database
      .select()
      .from(guildMemberPresences)
      .where(
        and(
          eq(guildMemberPresences.guildId, guildId),
          eq(guildMemberPresences.discordUserId, discordUserId),
        ),
      );
    return presence === undefined ? undefined : toGuildMemberPresence(presence);
  }

  public markMemberAbsent(guildId: string, discordUserId: string): Promise<GuildMemberPresence> {
    return this.saveMemberPresence(guildId, discordUserId, false);
  }

  public markMemberPresent(guildId: string, discordUserId: string): Promise<GuildMemberPresence> {
    return this.saveMemberPresence(guildId, discordUserId, true);
  }

  public async reconcileGuildMemberPresence(
    guildId: string,
    presentDiscordUserIds: readonly string[],
  ): Promise<void> {
    const currentMemberIds = [...new Set(presentDiscordUserIds)];
    await this.database.transaction(async (transaction) => {
      await transaction.insert(guilds).values({ guildId }).onConflictDoNothing();
      const staleCondition =
        currentMemberIds.length === 0
          ? and(eq(guildMemberPresences.guildId, guildId), eq(guildMemberPresences.isPresent, true))
          : and(
              eq(guildMemberPresences.guildId, guildId),
              eq(guildMemberPresences.isPresent, true),
              notInArray(guildMemberPresences.discordUserId, currentMemberIds),
            );
      await transaction
        .update(guildMemberPresences)
        .set({ isPresent: false, updatedAt: sql`now()` })
        .where(staleCondition);
      if (currentMemberIds.length > 0) {
        await transaction
          .insert(guildMemberPresences)
          .values(
            currentMemberIds.map((discordUserId) => ({ discordUserId, guildId, isPresent: true })),
          )
          .onConflictDoUpdate({
            target: [guildMemberPresences.guildId, guildMemberPresences.discordUserId],
            set: { isPresent: true, updatedAt: sql`now()` },
          });
      }
    });
  }

  public selectDefault(
    guildId: string,
    discordUserId: string,
    accountId: string,
  ): Promise<TrackedAccount | undefined> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
      const [candidate] = await transaction
        .select({ id: trackedAccounts.id })
        .from(trackedAccounts)
        .where(
          and(
            eq(trackedAccounts.guildId, guildId),
            eq(trackedAccounts.id, accountId),
            eq(trackedAccounts.associationType, 'linked'),
            eq(trackedAccounts.linkedDiscordUserId, discordUserId),
          ),
        );
      if (candidate === undefined) {
        return undefined;
      }

      await transaction
        .update(trackedAccounts)
        .set({ isDefault: false })
        .where(
          and(
            eq(trackedAccounts.guildId, guildId),
            eq(trackedAccounts.linkedDiscordUserId, discordUserId),
          ),
        );
      const [selected] = await transaction
        .update(trackedAccounts)
        .set({ isDefault: true })
        .where(and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, accountId)))
        .returning();
      return selected === undefined ? undefined : toTrackedAccount(selected);
    });
  }

  public rename(
    guildId: string,
    accountId: string,
    username: { displayUsername: string; normalizedUsername: string },
    canManageAccounts = false,
    activeCompetitionRenameConfirmed = false,
  ): Promise<
    | { kind: 'renamed'; account: TrackedAccount }
    | { kind: 'active_competition_locked' }
    | { kind: 'active_competition_confirmation_required' }
    | { kind: 'account_not_found' }
    | { kind: 'username_taken' }
  > {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
      const [account] = await transaction
        .select({ id: trackedAccounts.id })
        .from(trackedAccounts)
        .where(and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, accountId)));
      if (account === undefined) {
        return { kind: 'account_not_found' };
      }
      if (await this.contributesToLockedCompetition(transaction, guildId, accountId)) {
        if (!canManageAccounts) {
          return { kind: 'active_competition_locked' };
        }
        if (!activeCompetitionRenameConfirmed) {
          return { kind: 'active_competition_confirmation_required' };
        }
      }

      const existing = await this.findByNormalizedUsername(
        transaction,
        guildId,
        username.normalizedUsername,
      );
      if (existing !== undefined && existing.id !== accountId) {
        return { kind: 'username_taken' };
      }

      const [renamed] = await transaction
        .update(trackedAccounts)
        .set(username)
        .where(and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, accountId)))
        .returning();
      if (renamed === undefined) {
        throw new Error('Tracked account disappeared during rename.');
      }
      return { kind: 'renamed', account: toTrackedAccount(renamed) };
    });
  }

  public changeMode(
    guildId: string,
    accountId: string,
    accountMode: OsrsAccountMode,
  ): Promise<
    | { kind: 'mode_changed'; account: TrackedAccount }
    | { kind: 'active_competition_locked' }
    | { kind: 'account_not_found' }
  > {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
      if (await this.contributesToLockedCompetition(transaction, guildId, accountId)) {
        return { kind: 'active_competition_locked' };
      }
      const [changed] = await transaction
        .update(trackedAccounts)
        .set({ accountMode })
        .where(and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, accountId)))
        .returning();
      return changed === undefined
        ? { kind: 'account_not_found' }
        : { kind: 'mode_changed', account: toTrackedAccount(changed) };
    });
  }

  public convertAssociation(
    request: ConvertAccountAssociationRequest,
  ): Promise<
    | { kind: 'converted'; account: TrackedAccount }
    | { kind: 'active_competition_locked' }
    | { kind: 'forbidden' }
    | { kind: 'account_not_found' }
    | { kind: 'association_unchanged' }
    | { kind: 'account_limit_reached' }
  > {
    const { accountId, guildId, targetAssociation } = request;
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
      const [stored] = await transaction
        .select()
        .from(trackedAccounts)
        .where(and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, accountId)));
      if (stored === undefined) {
        return { kind: 'account_not_found' };
      }

      const account = toTrackedAccount(stored);
      if (account.association.type === targetAssociation.type) {
        return { kind: 'association_unchanged' };
      }
      if (!canConvertAccountAssociation(account, request)) {
        return { kind: 'forbidden' };
      }
      if (await this.contributesToLockedCompetition(transaction, guildId, accountId)) {
        return { kind: 'active_competition_locked' };
      }

      const quotaOwnerDiscordUserId =
        targetAssociation.type === 'linked'
          ? targetAssociation.discordUserId
          : account.registeredByDiscordUserId;
      const [countResult] = await transaction
        .select({ accountCount: count() })
        .from(trackedAccounts)
        .where(
          and(
            eq(trackedAccounts.guildId, guildId),
            eq(trackedAccounts.quotaOwnerDiscordUserId, quotaOwnerDiscordUserId),
            ne(trackedAccounts.id, accountId),
          ),
        );
      if (countResult === undefined) {
        throw new Error('Account quota count was not returned.');
      }
      if (countResult.accountCount >= MAX_TRACKED_ACCOUNTS_PER_MEMBER) {
        return { kind: 'account_limit_reached' };
      }

      if (targetAssociation.type === 'linked') {
        const [linkedAccount] = await transaction
          .select({ id: trackedAccounts.id })
          .from(trackedAccounts)
          .where(
            and(
              eq(trackedAccounts.guildId, guildId),
              eq(trackedAccounts.linkedDiscordUserId, targetAssociation.discordUserId),
            ),
          )
          .limit(1);
        const [converted] = await transaction
          .update(trackedAccounts)
          .set({
            associationType: 'linked',
            isDefault: linkedAccount === undefined,
            linkedDiscordUserId: targetAssociation.discordUserId,
            quotaOwnerDiscordUserId,
          })
          .where(and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, accountId)))
          .returning();
        if (converted === undefined) {
          throw new Error('Tracked account disappeared during association conversion.');
        }
        return { kind: 'converted', account: toTrackedAccount(converted) };
      }

      if (account.association.type !== 'linked') {
        throw new Error('Watchlist account cannot be converted to watchlist.');
      }
      const previousLinkedDiscordUserId = account.association.discordUserId;
      const [converted] = await transaction
        .update(trackedAccounts)
        .set({
          associationType: 'watchlist',
          isDefault: false,
          linkedDiscordUserId: null,
          quotaOwnerDiscordUserId,
        })
        .where(and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, accountId)))
        .returning();
      if (converted === undefined) {
        throw new Error('Tracked account disappeared during association conversion.');
      }
      if (account.isDefault) {
        const [replacement] = await transaction
          .select({ id: trackedAccounts.id })
          .from(trackedAccounts)
          .where(
            and(
              eq(trackedAccounts.guildId, guildId),
              eq(trackedAccounts.linkedDiscordUserId, previousLinkedDiscordUserId),
            ),
          )
          .orderBy(asc(trackedAccounts.createdAt), asc(trackedAccounts.id))
          .limit(1);
        if (replacement !== undefined) {
          await transaction
            .update(trackedAccounts)
            .set({ isDefault: true })
            .where(
              and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, replacement.id)),
            );
        }
      }
      return { kind: 'converted', account: toTrackedAccount(converted) };
    });
  }

  public reassignLinkedAccount(
    request: ReassignLinkedAccountRequest,
  ): Promise<ReassignLinkedAccountResult> {
    const { accountId, guildId, targetDiscordUserId } = request;
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
      const [stored] = await transaction
        .select()
        .from(trackedAccounts)
        .where(and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, accountId)));
      if (stored === undefined) {
        return { kind: 'account_not_found' };
      }

      const account = toTrackedAccount(stored);
      if (!request.canManageAccounts) {
        return { kind: 'forbidden' };
      }
      if (account.association.type !== 'linked') {
        return { kind: 'account_not_linked' };
      }
      if (!canReassignLinkedAccount(account, request)) {
        return { kind: 'forbidden' };
      }
      if (account.association.discordUserId === targetDiscordUserId) {
        return { kind: 'reassignment_unchanged' };
      }

      const [countResult] = await transaction
        .select({ accountCount: count() })
        .from(trackedAccounts)
        .where(
          and(
            eq(trackedAccounts.guildId, guildId),
            eq(trackedAccounts.quotaOwnerDiscordUserId, targetDiscordUserId),
          ),
        );
      if (countResult === undefined) {
        throw new Error('Account quota count was not returned.');
      }
      if (countResult.accountCount >= MAX_TRACKED_ACCOUNTS_PER_MEMBER) {
        return { kind: 'account_limit_reached' };
      }

      const [destinationAccount] = await transaction
        .select({ id: trackedAccounts.id })
        .from(trackedAccounts)
        .where(
          and(
            eq(trackedAccounts.guildId, guildId),
            eq(trackedAccounts.linkedDiscordUserId, targetDiscordUserId),
          ),
        )
        .limit(1);
      const sourceDiscordUserId = account.association.discordUserId;
      const [reassigned] = await transaction
        .update(trackedAccounts)
        .set({
          isDefault: destinationAccount === undefined,
          linkedDiscordUserId: targetDiscordUserId,
          quotaOwnerDiscordUserId: targetDiscordUserId,
        })
        .where(and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, accountId)))
        .returning();
      if (reassigned === undefined) {
        throw new Error('Tracked account disappeared during reassignment.');
      }

      if (account.isDefault) {
        const [replacement] = await transaction
          .select({ id: trackedAccounts.id })
          .from(trackedAccounts)
          .where(
            and(
              eq(trackedAccounts.guildId, guildId),
              eq(trackedAccounts.linkedDiscordUserId, sourceDiscordUserId),
            ),
          )
          .orderBy(asc(trackedAccounts.createdAt), asc(trackedAccounts.id))
          .limit(1);
        if (replacement !== undefined) {
          await transaction
            .update(trackedAccounts)
            .set({ isDefault: true })
            .where(
              and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, replacement.id)),
            );
        }
      }

      return { kind: 'reassigned', account: toTrackedAccount(reassigned) };
    });
  }

  public removeAccount(request: RemoveAccountRequest): Promise<RemoveAccountResult> {
    const { accountId, guildId } = request;
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
      const [stored] = await transaction
        .select()
        .from(trackedAccounts)
        .where(and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, accountId)));
      if (stored === undefined) {
        return { kind: 'account_not_found' };
      }

      const account = toTrackedAccount(stored);
      if (!canRemoveAccount(account, request)) {
        return { kind: 'forbidden' };
      }
      if (await this.contributesToNonTerminalCompetition(transaction, guildId, accountId)) {
        return { kind: 'active_competition_locked' };
      }

      await transaction
        .delete(trackedAccounts)
        .where(and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, accountId)));

      if (account.association.type !== 'linked' || !account.isDefault) {
        return { kind: 'removed', account };
      }

      const [replacement] = await transaction
        .select()
        .from(trackedAccounts)
        .where(
          and(
            eq(trackedAccounts.guildId, guildId),
            eq(trackedAccounts.linkedDiscordUserId, account.association.discordUserId),
          ),
        )
        .orderBy(asc(trackedAccounts.createdAt), asc(trackedAccounts.id))
        .limit(1);
      if (replacement === undefined) {
        return { kind: 'removed', account };
      }

      const [selected] = await transaction
        .update(trackedAccounts)
        .set({ isDefault: true })
        .where(and(eq(trackedAccounts.guildId, guildId), eq(trackedAccounts.id, replacement.id)))
        .returning();
      if (selected === undefined) {
        throw new Error('Default replacement account disappeared during removal.');
      }
      return {
        kind: 'removed',
        account,
        replacementDefaultAccount: toTrackedAccount(selected),
      };
    });
  }

  private async contributesToLockedCompetition(
    database: Transaction,
    guildId: string,
    accountId: string,
  ): Promise<boolean> {
    const [contribution] = await database
      .select({ competitionId: competitions.id })
      .from(competitionContributingAccounts)
      .innerJoin(
        competitions,
        and(
          eq(competitions.id, competitionContributingAccounts.competitionId),
          eq(competitions.guildId, competitionContributingAccounts.guildId),
        ),
      )
      .where(
        and(
          eq(competitionContributingAccounts.guildId, guildId),
          eq(competitionContributingAccounts.trackedAccountId, accountId),
          sql`${competitions.state} IN ('active', 'finish_pending')`,
        ),
      )
      .limit(1);
    return contribution !== undefined;
  }

  private async contributesToNonTerminalCompetition(
    database: Transaction,
    guildId: string,
    accountId: string,
  ): Promise<boolean> {
    const [contribution] = await database
      .select({ competitionId: competitions.id })
      .from(competitionContributingAccounts)
      .innerJoin(
        competitions,
        and(
          eq(competitions.id, competitionContributingAccounts.competitionId),
          eq(competitions.guildId, competitionContributingAccounts.guildId),
        ),
      )
      .where(
        and(
          eq(competitionContributingAccounts.guildId, guildId),
          eq(competitionContributingAccounts.trackedAccountId, accountId),
          sql`${competitions.state} NOT IN ('finished', 'cancelled')`,
        ),
      )
      .limit(1);
    return contribution !== undefined;
  }

  private async findByNormalizedUsername(
    database: Transaction,
    guildId: string,
    normalizedUsername: string,
  ) {
    const [account] = await database
      .select({ id: trackedAccounts.id })
      .from(trackedAccounts)
      .where(
        and(
          eq(trackedAccounts.guildId, guildId),
          eq(trackedAccounts.normalizedUsername, normalizedUsername),
        ),
      );
    return account;
  }

  private async hasLinkedAccount(database: Transaction, guildId: string, discordUserId: string) {
    const [account] = await database
      .select({ id: trackedAccounts.id })
      .from(trackedAccounts)
      .where(
        and(
          eq(trackedAccounts.guildId, guildId),
          eq(trackedAccounts.linkedDiscordUserId, discordUserId),
        ),
      )
      .limit(1);
    return account !== undefined;
  }

  private async saveMemberPresence(
    guildId: string,
    discordUserId: string,
    isPresent: boolean,
  ): Promise<GuildMemberPresence> {
    return this.database.transaction(async (transaction) => {
      await transaction.insert(guilds).values({ guildId }).onConflictDoNothing();
      const [presence] = await transaction
        .insert(guildMemberPresences)
        .values({ discordUserId, guildId, isPresent })
        .onConflictDoUpdate({
          target: [guildMemberPresences.guildId, guildMemberPresences.discordUserId],
          set: { isPresent, updatedAt: sql`now()` },
        })
        .returning();
      if (presence === undefined) {
        throw new Error('Guild member presence was not saved.');
      }
      return toGuildMemberPresence(presence);
    });
  }
}

function toTrackedAccount(account: typeof trackedAccounts.$inferSelect): TrackedAccount {
  return {
    accountMode: account.accountMode,
    association:
      account.associationType === 'linked'
        ? { type: 'linked', discordUserId: nonNull(account.linkedDiscordUserId) }
        : { type: 'watchlist' },
    createdAt: account.createdAt,
    displayUsername: account.displayUsername,
    guildId: account.guildId,
    id: account.id,
    isDefault: account.isDefault,
    normalizedUsername: account.normalizedUsername,
    quotaOwnerDiscordUserId: account.quotaOwnerDiscordUserId,
    registeredByDiscordUserId: account.registeredByDiscordUserId,
  };
}

function toGuildMemberPresence(
  presence: typeof guildMemberPresences.$inferSelect,
): GuildMemberPresence {
  return {
    discordUserId: presence.discordUserId,
    guildId: presence.guildId,
    isPresent: presence.isPresent,
    updatedAt: presence.updatedAt,
  };
}

function nonNull(value: string | null): string {
  if (value === null) {
    throw new Error('A linked account is missing its linked Discord user ID.');
  }
  return value;
}
