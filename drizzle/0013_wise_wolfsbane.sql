ALTER TABLE "competitions" DROP CONSTRAINT "competitions_definition_check";--> statement-breakpoint
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_definition_check" CHECK ((
        ("competitions"."type" IN ('most_skill_xp', 'most_boss_kc') AND "competitions"."duration_seconds" > 0 AND "competitions"."target_value" IS NULL)
        OR
        ("competitions"."type" IN ('skill_xp_target_race', 'boss_kc_target_race') AND "competitions"."target_value" > 0 AND ("competitions"."duration_seconds" IS NULL OR "competitions"."duration_seconds" > 0))
      ));