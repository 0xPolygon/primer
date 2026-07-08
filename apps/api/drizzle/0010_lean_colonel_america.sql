CREATE TABLE "external_otps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipient_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "external_recipients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"share_id" uuid NOT NULL,
	"email" text NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"first_viewed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "external_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"share_token" text NOT NULL,
	"published_version_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "external_viewer_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "external_views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipient_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
ALTER TABLE "external_otps" ADD CONSTRAINT "external_otps_recipient_id_external_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."external_recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_recipients" ADD CONSTRAINT "external_recipients_share_id_external_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."external_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_recipients" ADD CONSTRAINT "external_recipients_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_shares" ADD CONSTRAINT "external_shares_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_shares" ADD CONSTRAINT "external_shares_published_version_id_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_shares" ADD CONSTRAINT "external_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_viewer_sessions" ADD CONSTRAINT "external_viewer_sessions_recipient_id_external_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."external_recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_views" ADD CONSTRAINT "external_views_recipient_id_external_recipients_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."external_recipients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_views" ADD CONSTRAINT "external_views_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_otps_recipient_idx" ON "external_otps" USING btree ("recipient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_recipients_share_email_unique" ON "external_recipients" USING btree ("share_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "external_shares_token_unique" ON "external_shares" USING btree ("share_token");--> statement-breakpoint
CREATE UNIQUE INDEX "external_shares_doc_active_unique" ON "external_shares" USING btree ("document_id") WHERE "external_shares"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "external_viewer_sessions_recipient_idx" ON "external_viewer_sessions" USING btree ("recipient_id");--> statement-breakpoint
CREATE INDEX "external_viewer_sessions_expires_at_idx" ON "external_viewer_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "external_views_recipient_idx" ON "external_views" USING btree ("recipient_id");