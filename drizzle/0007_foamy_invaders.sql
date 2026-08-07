CREATE TYPE "public"."competition_entrant_type" AS ENUM('discord_member', 'watchlist');--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_id_guild_unique" UNIQUE("id","guild_id");--> statement-breakpoint
CREATE TABLE "competition_contributing_accounts" (
	"competition_entrant_id" text NOT NULL,
	"competition_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"tracked_account_id" text NOT NULL,
	CONSTRAINT "competition_contributing_accounts_competition_entrant_id_tracked_account_id_pk" PRIMARY KEY("competition_entrant_id","tracked_account_id"),
	CONSTRAINT "competition_contributing_accounts_competition_account_unique" UNIQUE("competition_id","tracked_account_id")
);
--> statement-breakpoint
CREATE TABLE "competition_entrants" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"competition_id" text NOT NULL,
	"entrant_type" "competition_entrant_type" NOT NULL,
	"discord_user_id" text,
	"watchlist_account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_entrants_id_guild_competition_unique" UNIQUE("id","guild_id","competition_id"),
	CONSTRAINT "competition_entrants_competition_discord_member_unique" UNIQUE("competition_id","discord_user_id"),
	CONSTRAINT "competition_entrants_competition_watchlist_account_unique" UNIQUE("competition_id","watchlist_account_id"),
	CONSTRAINT "competition_entrants_association_check" CHECK ((
        ("competition_entrants"."entrant_type" = 'discord_member' AND "competition_entrants"."discord_user_id" IS NOT NULL AND "competition_entrants"."watchlist_account_id" IS NULL)
        OR
        ("competition_entrants"."entrant_type" = 'watchlist' AND "competition_entrants"."discord_user_id" IS NULL AND "competition_entrants"."watchlist_account_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "competition_contributing_accounts" ADD CONSTRAINT "competition_contributing_accounts_entrant_guild_competition_fk" FOREIGN KEY ("competition_entrant_id","guild_id","competition_id") REFERENCES "public"."competition_entrants"("id","guild_id","competition_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_contributing_accounts" ADD CONSTRAINT "competition_contributing_accounts_competition_guild_fk" FOREIGN KEY ("competition_id","guild_id") REFERENCES "public"."competitions"("id","guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_contributing_accounts" ADD CONSTRAINT "competition_contributing_accounts_tracked_account_guild_fk" FOREIGN KEY ("tracked_account_id","guild_id") REFERENCES "public"."tracked_accounts"("id","guild_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_entrants" ADD CONSTRAINT "competition_entrants_competition_guild_fk" FOREIGN KEY ("competition_id","guild_id") REFERENCES "public"."competitions"("id","guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_entrants" ADD CONSTRAINT "competition_entrants_watchlist_account_guild_fk" FOREIGN KEY ("watchlist_account_id","guild_id") REFERENCES "public"."tracked_accounts"("id","guild_id") ON DELETE restrict ON UPDATE no action;
