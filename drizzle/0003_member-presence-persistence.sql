CREATE TABLE "guild_member_presences" (
	"guild_id" text NOT NULL,
	"discord_user_id" text NOT NULL,
	"is_present" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_member_presences_guild_id_discord_user_id_pk" PRIMARY KEY("guild_id","discord_user_id")
);
--> statement-breakpoint
ALTER TABLE "guild_member_presences" ADD CONSTRAINT "guild_member_presences_guild_id_guilds_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("guild_id") ON DELETE cascade ON UPDATE no action;
