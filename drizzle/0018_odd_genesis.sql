ALTER TYPE "public"."competition_role_status" ADD VALUE 'creating' BEFORE 'active';--> statement-breakpoint
ALTER TYPE "public"."competition_role_status" ADD VALUE 'cleaning' BEFORE 'cleaned';