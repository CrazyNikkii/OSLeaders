CREATE TYPE "public"."administrative_log_mode" AS ENUM('standard', 'verbose');--> statement-breakpoint
CREATE TABLE "guild_configurations" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"bot_manager_role_id" text,
	"competition_manager_role_id" text,
	"administrative_log_channel_id" text,
	"administrative_log_mode" "administrative_log_mode" DEFAULT 'standard' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guild_configurations" ADD CONSTRAINT "guild_configurations_guild_id_guilds_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("guild_id") ON DELETE cascade ON UPDATE no action;