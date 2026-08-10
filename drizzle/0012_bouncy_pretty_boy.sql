CREATE TYPE "public"."competition_target_claim_status" AS ENUM('pending', 'not_reached', 'verification_failed', 'verified');--> statement-breakpoint
CREATE TABLE "competition_target_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"competition_id" text NOT NULL,
	"competition_entrant_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"status" "competition_target_claim_status" DEFAULT 'pending' NOT NULL,
	"verification_attempt_count" integer DEFAULT 0 NOT NULL,
	"last_failure_summary" text,
	"verified_at" timestamp with time zone,
	"final_value" bigint,
	CONSTRAINT "competition_target_claims_id_guild_competition_unique" UNIQUE("id","guild_id","competition_id")
);
--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "winning_target_claim_id" text;--> statement-breakpoint
ALTER TABLE "competition_target_claims" ADD CONSTRAINT "competition_target_claims_competition_guild_fk" FOREIGN KEY ("competition_id","guild_id") REFERENCES "public"."competitions"("id","guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_target_claims" ADD CONSTRAINT "competition_target_claims_entrant_guild_competition_fk" FOREIGN KEY ("competition_entrant_id","guild_id","competition_id") REFERENCES "public"."competition_entrants"("id","guild_id","competition_id") ON DELETE restrict ON UPDATE no action;