CREATE TABLE "competition_account_snapshots" (
	"competition_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"tracked_account_id" text NOT NULL,
	"competition_entrant_id" text NOT NULL,
	"display_username" text NOT NULL,
	"account_mode" "osrs_account_mode" NOT NULL,
	"starting_value" bigint NOT NULL,
	"starting_observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "competition_account_snapshots_competition_id_tracked_account_id_pk" PRIMARY KEY("competition_id","tracked_account_id")
);
--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competition_account_snapshots" ADD CONSTRAINT "competition_account_snapshots_competition_guild_fk" FOREIGN KEY ("competition_id","guild_id") REFERENCES "public"."competitions"("id","guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_account_snapshots" ADD CONSTRAINT "competition_account_snapshots_entrant_guild_competition_fk" FOREIGN KEY ("competition_entrant_id","guild_id","competition_id") REFERENCES "public"."competition_entrants"("id","guild_id","competition_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_account_snapshots" ADD CONSTRAINT "competition_account_snapshots_tracked_account_guild_fk" FOREIGN KEY ("tracked_account_id","guild_id") REFERENCES "public"."tracked_accounts"("id","guild_id") ON DELETE restrict ON UPDATE no action;