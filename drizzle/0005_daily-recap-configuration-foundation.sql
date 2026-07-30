CREATE TYPE "public"."daily_recap_delivery_status" AS ENUM('pending', 'delivering', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."daily_recap_run_status" AS ENUM('pending_collection', 'collecting', 'delivery_pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."daily_recap_run_trigger" AS ENUM('automatic', 'manual');--> statement-breakpoint
CREATE TABLE "daily_recap_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"recap_run_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"content" text NOT NULL,
	"status" "daily_recap_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_failure_summary" text,
	"discord_message_id" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_recap_deliveries_run_guild_unique" UNIQUE("recap_run_id","guild_id"),
	CONSTRAINT "daily_recap_deliveries_attempt_count_check" CHECK ("daily_recap_deliveries"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "daily_recap_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"trigger" "daily_recap_run_trigger" NOT NULL,
	"status" "daily_recap_run_status" DEFAULT 'pending_collection' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"collection_attempt_count" integer DEFAULT 0 NOT NULL,
	"next_collection_attempt_at" timestamp with time zone,
	"last_collection_failure_summary" text,
	"collection_started_at" timestamp with time zone,
	"collection_completed_at" timestamp with time zone,
	"comparison_started_at" timestamp with time zone,
	"comparison_completed_at" timestamp with time zone,
	"account_outcomes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_recap_runs_id_guild_unique" UNIQUE("id","guild_id"),
	CONSTRAINT "daily_recap_runs_automatic_schedule_check" CHECK (("daily_recap_runs"."trigger" <> 'automatic' OR "daily_recap_runs"."scheduled_for" IS NOT NULL)),
	CONSTRAINT "daily_recap_runs_collection_attempt_count_check" CHECK ("daily_recap_runs"."collection_attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "guild_configurations" ADD COLUMN "recap_channel_id" text;--> statement-breakpoint
ALTER TABLE "guild_configurations" ADD COLUMN "recap_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_configurations" ADD COLUMN "recap_local_time" text;--> statement-breakpoint
ALTER TABLE "guild_configurations" ADD COLUMN "timezone" text DEFAULT 'Europe/Helsinki' NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_recap_deliveries" ADD CONSTRAINT "daily_recap_deliveries_guild_id_guilds_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_recap_deliveries" ADD CONSTRAINT "daily_recap_deliveries_run_guild_daily_recap_runs_fk" FOREIGN KEY ("recap_run_id","guild_id") REFERENCES "public"."daily_recap_runs"("id","guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_recap_runs" ADD CONSTRAINT "daily_recap_runs_guild_id_guilds_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_recap_deliveries_status_next_attempt_at_index" ON "daily_recap_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_recap_runs_automatic_schedule_unique" ON "daily_recap_runs" USING btree ("guild_id","scheduled_for") WHERE "daily_recap_runs"."trigger" = 'automatic';--> statement-breakpoint
CREATE INDEX "daily_recap_runs_guild_status_scheduled_for_index" ON "daily_recap_runs" USING btree ("guild_id","status","scheduled_for");--> statement-breakpoint
CREATE INDEX "daily_recap_runs_status_next_collection_attempt_at_index" ON "daily_recap_runs" USING btree ("status","next_collection_attempt_at");