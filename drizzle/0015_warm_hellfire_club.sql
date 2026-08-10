ALTER TABLE "competitions" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "competitions" ADD COLUMN "is_result_delayed" boolean DEFAULT false NOT NULL;