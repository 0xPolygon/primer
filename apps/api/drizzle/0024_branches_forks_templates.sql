ALTER TABLE "doc_files" ADD COLUMN "copied_from" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "branch_of" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "branch_base_doc_version" bigint;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "branch_base_state" "bytea";--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "forked_from" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "is_template" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "copied_from" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_branch_of_documents_id_fk" FOREIGN KEY ("branch_of") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_forked_from_documents_id_fk" FOREIGN KEY ("forked_from") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;