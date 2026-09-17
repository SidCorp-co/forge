CREATE TABLE "repo_pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"issue_id" uuid,
	"number" integer NOT NULL,
	"repo_full_name" text NOT NULL,
	"title" text NOT NULL,
	"html_url" text,
	"state" text NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"head_ref" text NOT NULL,
	"head_sha" text NOT NULL,
	"base_ref" text NOT NULL,
	"base_sha" text NOT NULL,
	"behind_by" integer,
	"ahead_by" integer,
	"mergeable" boolean,
	"mergeable_state" text,
	"refreshed_for_head" text,
	"refreshed_at" timestamp with time zone,
	"refresh_error" text,
	"merged_at" timestamp with time zone,
	"merge_commit_sha" text,
	"checks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reviews" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_pull_requests_state_chk" CHECK (state IN ('open', 'closed', 'merged'))
);
--> statement-breakpoint
ALTER TABLE "repo_pull_requests" ADD CONSTRAINT "repo_pull_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_pull_requests" ADD CONSTRAINT "repo_pull_requests_binding_id_integration_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."integration_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_pull_requests" ADD CONSTRAINT "repo_pull_requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_pull_requests_binding_number_uq" ON "repo_pull_requests" USING btree ("binding_id","number");--> statement-breakpoint
CREATE INDEX "repo_pull_requests_issue_idx" ON "repo_pull_requests" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "repo_pull_requests_project_state_idx" ON "repo_pull_requests" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "repo_pull_requests_base_idx" ON "repo_pull_requests" USING btree ("binding_id","base_ref","state");