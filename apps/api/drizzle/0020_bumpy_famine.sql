CREATE TABLE "doc_decisions" (
	"document_id" uuid NOT NULL,
	"block_id" text NOT NULL,
	"option_id" text NOT NULL,
	"rationale" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"open_questions" jsonb NOT NULL,
	"decided_by" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "doc_decisions_document_id_block_id_pk" PRIMARY KEY("document_id","block_id")
);
--> statement-breakpoint
CREATE TABLE "doc_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"tab_id" text NOT NULL,
	"block_id" text NOT NULL,
	"title" text NOT NULL,
	"assignee_id" text,
	"due_date" date,
	"status" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_decisions" ADD CONSTRAINT "doc_decisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_decisions" ADD CONSTRAINT "doc_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_tasks" ADD CONSTRAINT "doc_tasks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_tasks" ADD CONSTRAINT "doc_tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_tasks" ADD CONSTRAINT "doc_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "doc_tasks_block" ON "doc_tasks" USING btree ("document_id","block_id");--> statement-breakpoint
CREATE INDEX "doc_tasks_assignee" ON "doc_tasks" USING btree ("assignee_id");