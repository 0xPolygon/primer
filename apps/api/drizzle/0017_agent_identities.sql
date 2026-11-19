ALTER TABLE "users" ADD COLUMN "kind" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "via_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_via_user_id_users_id_fk" FOREIGN KEY ("via_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The shared Claude service account becomes an agent acting via no one.
-- Its tokens were managed by the admin-only service-token routes, which are
-- gone; no person can be named as its owner from the database (admins are
-- an env allowlist), so nobody could list or revoke them any more. Revoke
-- them; admins mint replacements as agent tokens.
UPDATE "users" SET "kind" = 'agent' WHERE "id" = 'service-claude';--> statement-breakpoint
UPDATE "api_tokens" SET "revoked_at" = now() WHERE "user_id" = 'service-claude' AND "revoked_at" IS NULL;
