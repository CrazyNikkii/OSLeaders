CREATE TABLE "competition_account_final_values" (
	"competition_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"tracked_account_id" text NOT NULL,
	"final_value" bigint NOT NULL,
	"final_observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "competition_account_final_values_competition_id_tracked_account_id_pk" PRIMARY KEY("competition_id","tracked_account_id")
);
--> statement-breakpoint
CREATE TABLE "competition_winners" (
	"competition_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"competition_entrant_id" text NOT NULL,
	"final_gain" bigint NOT NULL,
	CONSTRAINT "competition_winners_competition_id_competition_entrant_id_pk" PRIMARY KEY("competition_id","competition_entrant_id")
);
--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "finish_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "next_finish_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "last_finish_failure_summary" text;--> statement-breakpoint
ALTER TABLE "competition_account_final_values" ADD CONSTRAINT "competition_account_final_values_competition_guild_fk" FOREIGN KEY ("competition_id","guild_id") REFERENCES "public"."competitions"("id","guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_account_final_values" ADD CONSTRAINT "competition_account_final_values_snapshot_fk" FOREIGN KEY ("competition_id","tracked_account_id") REFERENCES "public"."competition_account_snapshots"("competition_id","tracked_account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_winners" ADD CONSTRAINT "competition_winners_competition_guild_fk" FOREIGN KEY ("competition_id","guild_id") REFERENCES "public"."competitions"("id","guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_winners" ADD CONSTRAINT "competition_winners_entrant_guild_competition_fk" FOREIGN KEY ("competition_entrant_id","guild_id","competition_id") REFERENCES "public"."competition_entrants"("id","guild_id","competition_id") ON DELETE restrict ON UPDATE no action;