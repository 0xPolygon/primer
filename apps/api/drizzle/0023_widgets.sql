CREATE TABLE "widgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"block_id" text NOT NULL,
	"draft_source" text,
	"draft_rows" jsonb,
	"draft_errors" jsonb,
	"published_source" text,
	"published_svg_light" text,
	"published_svg_dark" text,
	"published_hash" text,
	"rows" jsonb,
	"collection" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "widgets_document_id_idx" ON "widgets" USING btree ("document_id");