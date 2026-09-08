CREATE TABLE "agent_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_id" uuid,
	"agent_session_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"blocker_kind" text NOT NULL,
	"steps" jsonb NOT NULL,
	"max_rounds" integer DEFAULT 3 NOT NULL,
	"assumed" jsonb,
	"void_reason" text,
	"claims_held" integer DEFAULT 0 NOT NULL,
	"workspaces_pinned" integer DEFAULT 0 NOT NULL,
	"dependents" integer DEFAULT 0 NOT NULL,
	"park_deadline_at" timestamp with time zone,
	"ended_by" text,
	"ended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_questions_project_status_idx" ON "agent_questions" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "agent_questions_session_idx" ON "agent_questions" USING btree ("agent_session_id");