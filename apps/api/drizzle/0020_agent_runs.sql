CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"request" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status_line" text,
	"error" text,
	"edits_applied" integer DEFAULT 0 NOT NULL,
	"blocks_removed" integer DEFAULT 0 NOT NULL,
	"plan" text,
	"plan_approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "run_inverses" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"target" jsonb NOT NULL,
	"prior" jsonb,
	"after_version" text,
	"place" jsonb,
	"created_fragment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_plan_approved_by_users_id_fk" FOREIGN KEY ("plan_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_inverses" ADD CONSTRAINT "run_inverses_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_inverses" ADD CONSTRAINT "run_inverses_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_active_dedupe" ON "agent_runs" USING btree ("document_id","agent_id","dedupe_key") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "agent_runs_document_id_idx" ON "agent_runs" USING btree ("document_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_id_idx" ON "agent_runs" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "run_inverses_run_id_idx" ON "run_inverses" USING btree ("run_id","id");