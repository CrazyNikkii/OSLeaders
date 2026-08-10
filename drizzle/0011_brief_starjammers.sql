CREATE TABLE "competition_account_progress" (
	"competition_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"tracked_account_id" text NOT NULL,
	"last_known_value" bigint NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "competition_account_progress_competition_id_tracked_account_id_pk" PRIMARY KEY("competition_id","tracked_account_id")
);
--> statement-breakpoint
ALTER TABLE "competition_account_progress" ADD CONSTRAINT "competition_account_progress_competition_guild_fk" FOREIGN KEY ("competition_id","guild_id") REFERENCES "public"."competitions"("id","guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_account_progress" ADD CONSTRAINT "competition_account_progress_snapshot_fk" FOREIGN KEY ("competition_id","tracked_account_id") REFERENCES "public"."competition_account_snapshots"("competition_id","tracked_account_id") ON DELETE cascade ON UPDATE no action;