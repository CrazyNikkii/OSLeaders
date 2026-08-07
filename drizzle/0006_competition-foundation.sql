CREATE TYPE "public"."competition_metric_kind" AS ENUM('skill', 'boss');--> statement-breakpoint
CREATE TYPE "public"."competition_state" AS ENUM('draft', 'start_pending', 'active', 'finish_pending', 'finished', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."competition_type" AS ENUM('most_skill_xp', 'skill_xp_target_race', 'most_boss_kc', 'boss_kc_target_race');--> statement-breakpoint
CREATE TABLE "competitions" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"display_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"type" "competition_type" NOT NULL,
	"metric_kind" "competition_metric_kind" NOT NULL,
	"metric_name" text NOT NULL,
	"target_value" bigint,
	"duration_seconds" integer,
	"timezone" text NOT NULL,
	"state" "competition_state" DEFAULT 'draft' NOT NULL,
	"created_by_discord_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competitions_guild_normalized_name_unique" UNIQUE("guild_id","normalized_name"),
	CONSTRAINT "competitions_definition_check" CHECK ((
        ("competitions"."type" IN ('most_skill_xp', 'most_boss_kc') AND "competitions"."duration_seconds" > 0 AND "competitions"."target_value" IS NULL)
        OR
        ("competitions"."type" IN ('skill_xp_target_race', 'boss_kc_target_race') AND "competitions"."target_value" > 0 AND "competitions"."duration_seconds" IS NULL)
      )),
	CONSTRAINT "competitions_metric_type_check" CHECK ((
        ("competitions"."type" IN ('most_skill_xp', 'skill_xp_target_race') AND "competitions"."metric_kind" = 'skill')
        OR
        ("competitions"."type" IN ('most_boss_kc', 'boss_kc_target_race') AND "competitions"."metric_kind" = 'boss')
      ))
);
--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_guild_id_guilds_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("guild_id") ON DELETE cascade ON UPDATE no action;