import { and, asc, count, eq, sql } from 'drizzle-orm';

import type { AccountRetrievalRepository } from '../../features/accounts/account-retrieval.js';
import type { AccountModeChangeRepository } from '../../features/accounts/change-account-mode.js';
import type { DefaultAccountSelectionRepository } from '../../features/accounts/select-default-account.js';
import type { AccountRenameRepository } from '../../features/accounts/rename-account.js';
import {
  MAX_TRACKED_ACCOUNTS_PER_MEMBER,
  type AccountRegistrationRepository,
  type InitialRecapBaseline,
  type TrackedAccount,
} from '../../features/accounts/register-account.js';
import type { OsrsAccountMode } from '../hiscores/osrs-hiscore-catalog.js';
import type { Database, Transaction } from './connection.js';
import { guilds, recapBaselines, trackedAccounts } from './schema/index.js';

export class PostgresAccountRegistrationRepository
  implements
    AccountRegistrationRepository,
    AccountRetrievalRepository,
    DefaultAccountSelectionRepository,
    AccountModeChangeRepository,
    AccountRenameRepository
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
  ): Promise<
    | { kind: 'renamed'; account: TrackedAccount }
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
  ): Promise<{ kind: 'mode_changed'; account: TrackedAccount } | { kind: 'account_not_found' }> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId}, 0))`);
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

function nonNull(value: string | null): string {
  if (value === null) {
    throw new Error('A linked account is missing its linked Discord user ID.');
  }
  return value;
}
