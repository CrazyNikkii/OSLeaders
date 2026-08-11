CREATE TYPE "public"."competition_result_delivery_status" AS ENUM('pending', 'delivering', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE "competition_result_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"competition_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"status" "competition_result_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_failure_summary" text,
	"discord_message_id" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_result_deliveries_competition_guild_unique" UNIQUE("competition_id","guild_id"),
	CONSTRAINT "competition_result_deliveries_attempt_count_check" CHECK ("competition_result_deliveries"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "guild_configurations" ADD COLUMN "competition_channel_id" text;--> statement-breakpoint
ALTER TABLE "competition_result_deliveries" ADD CONSTRAINT "competition_result_deliveries_guild_id_guilds_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_result_deliveries" ADD CONSTRAINT "competition_result_deliveries_competition_guild_fk" FOREIGN KEY ("competition_id","guild_id") REFERENCES "public"."competitions"("id","guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competition_result_deliveries_status_next_attempt_at_index" ON "competition_result_deliveries" USING btree ("status","next_attempt_at");