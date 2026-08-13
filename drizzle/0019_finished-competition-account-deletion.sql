ALTER TABLE "competition_account_snapshots" DROP CONSTRAINT "competition_account_snapshots_tracked_account_guild_fk";
--> statement-breakpoint
ALTER TABLE "competition_contributing_accounts" DROP CONSTRAINT "competition_contributing_accounts_tracked_account_guild_fk";
--> statement-breakpoint
ALTER TABLE "competition_entrants" DROP CONSTRAINT "competition_entrants_watchlist_account_guild_fk";
