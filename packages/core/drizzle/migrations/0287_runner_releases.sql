CREATE TABLE "runner_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"repository" text NOT NULL,
	"version" text NOT NULL,
	"tag" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"commit_sha" text,
	"tag_commit_sha" text,
	"status" text DEFAULT 'preflight' NOT NULL,
	"step" text DEFAULT 'resolve_repository' NOT NULL,
	"tag_state" text DEFAULT 'unread' NOT NULL,
	"publication" text DEFAULT 'unread' NOT NULL,
	"publication_detail" text,
	"workflow_run_id" text,
	"workflow_url" text,
	"build_conclusion" text,
	"release_url" text,
	"failure" text,
	"readings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_by_id" uuid,
	"deadline_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tag_cut_at" timestamp with time zone,
	"build_reported_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_releases_status_chk" CHECK (status IN ('preflight', 'cutting', 'building', 'published', 'failed')),
	CONSTRAINT "runner_releases_tag_state_chk" CHECK (tag_state IN ('unread', 'absent', 'unknown', 'present')),
	CONSTRAINT "runner_releases_settled_chk" CHECK ((status IN ('published', 'failed')) = (settled_at IS NOT NULL)),
	CONSTRAINT "runner_releases_published_chk" CHECK (status <> 'published' OR (tag_state = 'present' AND publication = 'published')),
	CONSTRAINT "runner_releases_attempt_chk" CHECK (attempt >= 1)
);
--> statement-breakpoint
ALTER TABLE "runner_releases" ADD CONSTRAINT "runner_releases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_releases" ADD CONSTRAINT "runner_releases_binding_id_integration_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."integration_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_releases" ADD CONSTRAINT "runner_releases_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_releases_project_tag_uq" ON "runner_releases" USING btree ("project_id","tag");--> statement-breakpoint
CREATE INDEX "runner_releases_binding_tag_idx" ON "runner_releases" USING btree ("binding_id","tag");--> statement-breakpoint
CREATE INDEX "runner_releases_project_status_idx" ON "runner_releases" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "runner_releases_deadline_idx" ON "runner_releases" USING btree ("deadline_at") WHERE settled_at IS NULL;