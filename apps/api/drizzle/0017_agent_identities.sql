ALTER TABLE "users" ADD COLUMN "kind" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "via_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_via_user_id_users_id_fk" FOREIGN KEY ("via_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The shared Claude service account becomes an agent acting via no one, so
-- its existing tokens keep working with their own role only.
UPDATE "users" SET "kind" = 'agent' WHERE "id" = 'service-claude';
