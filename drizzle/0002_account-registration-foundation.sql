CREATE TYPE "public"."account_association_type" AS ENUM('linked', 'watchlist');--> statement-breakpoint
CREATE TYPE "public"."osrs_account_mode" AS ENUM('main', 'ironman', 'hardcore_ironman', 'ultimate_ironman', 'group_ironman', 'hardcore_group_ironman');--> statement-breakpoint
CREATE TABLE "recap_baselines" (
	"account_id" text PRIMARY KEY NOT NULL,
	"boss_kill_counts" jsonb NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"guild_id" text NOT NULL,
	"skill_experience" jsonb NOT NULL,
	"skill_levels" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"display_username" text NOT NULL,
	"normalized_username" text NOT NULL,
	"account_mode" "osrs_account_mode" NOT NULL,
	"association_type" "account_association_type" NOT NULL,
	"linked_discord_user_id" text,
	"quota_owner_discord_user_id" text NOT NULL,
	"registered_by_discord_user_id" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_accounts_id_guild_unique" UNIQUE("id","guild_id"),
	CONSTRAINT "tracked_accounts_association_check" CHECK ((
        ("tracked_accounts"."association_type" = 'linked' AND "tracked_accounts"."linked_discord_user_id" IS NOT NULL)
        OR ("tracked_accounts"."association_type" = 'watchlist' AND "tracked_accounts"."linked_discord_user_id" IS NULL)
      )),
	CONSTRAINT "tracked_accounts_default_check" CHECK ((NOT "tracked_accounts"."is_default" OR "tracked_accounts"."association_type" = 'linked'))
);
--> statement-breakpoint
ALTER TABLE "recap_baselines" ADD CONSTRAINT "recap_baselines_guild_id_guilds_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recap_baselines" ADD CONSTRAINT "recap_baselines_account_guild_tracked_accounts_fk" FOREIGN KEY ("account_id","guild_id") REFERENCES "public"."tracked_accounts"("id","guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_accounts" ADD CONSTRAINT "tracked_accounts_guild_id_guilds_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_accounts_guild_normalized_username_unique" ON "tracked_accounts" USING btree ("guild_id","normalized_username");--> statement-breakpoint
CREATE INDEX "tracked_accounts_guild_quota_owner_index" ON "tracked_accounts" USING btree ("guild_id","quota_owner_discord_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_accounts_guild_linked_default_unique" ON "tracked_accounts" USING btree ("guild_id","linked_discord_user_id") WHERE "tracked_accounts"."is_default";