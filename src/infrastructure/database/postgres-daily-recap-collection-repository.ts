import { and, asc, eq } from 'drizzle-orm';

import type {
  DailyRecapCollectionRepository,
  RecapCollectionAccount,
} from '../../features/recaps/daily-recap-collection.js';
import type { TrackedAccount } from '../../features/accounts/register-account.js';
import type { Database } from './connection.js';
import { recapBaselines, trackedAccounts } from './schema/index.js';

export class PostgresDailyRecapCollectionRepository implements DailyRecapCollectionRepository {
  public constructor(private readonly database: Database) {}

  public async listForGuild(guildId: string): Promise<readonly RecapCollectionAccount[]> {
    const rows = await this.database
      .select({ account: trackedAccounts, baseline: recapBaselines })
      .from(trackedAccounts)
      .innerJoin(
        recapBaselines,
        and(
          eq(recapBaselines.accountId, trackedAccounts.id),
          eq(recapBaselines.guildId, trackedAccounts.guildId),
        ),
      )
      .where(eq(trackedAccounts.guildId, guildId))
      .orderBy(asc(trackedAccounts.createdAt), asc(trackedAccounts.id));

    return rows.map(({ account, baseline }) => ({
      account: toTrackedAccount(account),
      baseline: {
        bossKillCounts: baseline.bossKillCounts as Record<string, number>,
        capturedAt: baseline.capturedAt,
        skillExperience: baseline.skillExperience as Record<string, number>,
        skillLevels: baseline.skillLevels as Record<string, number>,
      },
    }));
  }
}

function toTrackedAccount(account: typeof trackedAccounts.$inferSelect): TrackedAccount {
  return {
    accountMode: account.accountMode,
    association:
      account.associationType === 'linked'
        ? { discordUserId: nonNull(account.linkedDiscordUserId), type: 'linked' }
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
    throw new Error('Linked tracked account is missing its Discord user ID.');
  }
  return value;
}
