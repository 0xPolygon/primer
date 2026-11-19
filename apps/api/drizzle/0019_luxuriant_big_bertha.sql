CREATE TABLE "doc_record_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"collection" text NOT NULL,
	"record_id" text NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" text,
	"op" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"before_contributors" text[],
	"after_contributors" text[],
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_records" (
	"document_id" uuid NOT NULL,
	"collection" text NOT NULL,
	"record_id" text NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" text,
	"data" jsonb NOT NULL,
	"contributors" text[] NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_record_changes" ADD CONSTRAINT "doc_record_changes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_record_changes" ADD CONSTRAINT "doc_record_changes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_record_changes" ADD CONSTRAINT "doc_record_changes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_records" ADD CONSTRAINT "doc_records_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_records" ADD CONSTRAINT "doc_records_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_records" ADD CONSTRAINT "doc_records_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_record_changes_doc_idx" ON "doc_record_changes" USING btree ("document_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_records_key" ON "doc_records" USING btree ("document_id","collection","scope",coalesce("owner_user_id", ''),"record_id");