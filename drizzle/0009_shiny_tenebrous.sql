ALTER TABLE "competitions" ADD COLUMN "start_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "next_start_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "last_start_failure_summary" text;