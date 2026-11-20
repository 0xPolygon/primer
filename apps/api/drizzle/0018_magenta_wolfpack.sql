CREATE TABLE "doc_files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_snapshots" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"state" "bytea" NOT NULL,
	"upto_update_id" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_updates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"update" "bytea",
	"actor_id" text,
	"run_id" uuid,
	"touched" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "format" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "agent_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "bundle_key" text;--> statement-breakpoint
ALTER TABLE "versions" ADD COLUMN "doc_version" bigint;--> statement-breakpoint
ALTER TABLE "doc_files" ADD CONSTRAINT "doc_files_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_files" ADD CONSTRAINT "doc_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_snapshots" ADD CONSTRAINT "doc_snapshots_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_updates" ADD CONSTRAINT "doc_updates_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_updates" ADD CONSTRAINT "doc_updates_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_files_document_id_idx" ON "doc_files" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "doc_updates_document_id_idx" ON "doc_updates" USING btree ("document_id","id");