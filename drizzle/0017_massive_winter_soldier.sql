CREATE TYPE "public"."competition_role_status" AS ENUM('pending_create', 'active', 'cleanup_pending', 'cleaned');--> statement-breakpoint
CREATE TABLE "competition_roles" (
	"competition_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"discord_role_id" text,
	"status" "competition_role_status" DEFAULT 'pending_create' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_failure_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competition_roles_competition_id_guild_id_pk" PRIMARY KEY("competition_id","guild_id"),
	CONSTRAINT "competition_roles_attempt_count_check" CHECK ("competition_roles"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "competition_roles" ADD CONSTRAINT "competition_roles_competition_guild_fk" FOREIGN KEY ("competition_id","guild_id") REFERENCES "public"."competitions"("id","guild_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competition_roles_status_next_attempt_at_index" ON "competition_roles" USING btree ("status","next_attempt_at");
--> statement-breakpoint
INSERT INTO "competition_roles" ("competition_id", "guild_id", "status")
SELECT "id", "guild_id",
  CASE WHEN "state" IN ('finished', 'cancelled') THEN 'cleanup_pending'::"competition_role_status"
       ELSE 'pending_create'::"competition_role_status" END
FROM "competitions"
ON CONFLICT ("competition_id", "guild_id") DO NOTHING;
