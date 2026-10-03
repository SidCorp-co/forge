-- ISS-55 — an issue's acceptance criteria and the verdicts on them are rows, not comment prose
-- (workflow `issue-lifecycle` rev 2: the `awaiting_release` gate, NO_WORK_EVIDENCE /
-- VERDICT_IDENTITY_REQUIRED, reads `criterion_verdicts` instead of re-parsing comments).
--
-- issue_criteria      one row per criterion; `n` is the number a verdict names; a reworded or
--                     removed criterion is retired (`retired_at`), never deleted.
-- criterion_verdicts  insert-only; verdict pass | short | fail | skipped (skipped needs a reason
--                     and never passes); a typed identity (commit = a full 40-hex sha, runtime,
--                     design workflow + revision, contract ref + version); `commit_unresolved`
--                     only on a backfilled row (the priced amnesty for abbreviated shas on closed
--                     issues, which the gate never counts).
--
-- The rows already held as text (`issues.acceptance_criteria`, `forge-record: verdict` comment
-- fences) are read in by `issues/criteria/backfill.ts`, run once by `db/migrate.ts` after this file;
-- every row it cannot represent is refused by name in the deploy log, never skipped silently.

CREATE TABLE "criterion_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criterion_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"reason" text,
	"identity_kind" text,
	"commit_sha" text,
	"runtime_ref" text,
	"design_workflow_id" uuid,
	"design_revision" integer,
	"contract_ref" text,
	"contract_version" text,
	"evidence" text[] DEFAULT '{}'::text[] NOT NULL,
	"author_user_id" uuid,
	"author_device_id" uuid,
	"author_agency" text NOT NULL,
	"comment_id" uuid,
	"backfilled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "criterion_verdicts_verdict_chk" CHECK ("criterion_verdicts"."verdict" IN ('pass', 'short', 'fail', 'skipped')),
	CONSTRAINT "criterion_verdicts_skipped_reason_chk" CHECK ("criterion_verdicts"."verdict" <> 'skipped' OR coalesce("criterion_verdicts"."reason", '') ~ '[^[:space:]]'),
	CONSTRAINT "criterion_verdicts_earned_identity_chk" CHECK ("criterion_verdicts"."verdict" NOT IN ('pass', 'short') OR "criterion_verdicts"."identity_kind" IS NOT NULL),
	CONSTRAINT "criterion_verdicts_identity_chk" CHECK (("criterion_verdicts"."identity_kind" IS NULL AND "criterion_verdicts"."commit_sha" IS NULL AND "criterion_verdicts"."runtime_ref" IS NULL AND "criterion_verdicts"."design_workflow_id" IS NULL AND "criterion_verdicts"."design_revision" IS NULL AND "criterion_verdicts"."contract_ref" IS NULL AND "criterion_verdicts"."contract_version" IS NULL)
        OR ("criterion_verdicts"."identity_kind" = 'commit' AND "criterion_verdicts"."commit_sha" ~ '^[0-9a-f]{40}$' AND "criterion_verdicts"."runtime_ref" IS NULL AND "criterion_verdicts"."design_workflow_id" IS NULL AND "criterion_verdicts"."design_revision" IS NULL AND "criterion_verdicts"."contract_ref" IS NULL AND "criterion_verdicts"."contract_version" IS NULL)
        OR ("criterion_verdicts"."identity_kind" = 'commit_unresolved' AND "criterion_verdicts"."backfilled" AND "criterion_verdicts"."commit_sha" ~ '^[0-9a-f]{7,39}$' AND "criterion_verdicts"."runtime_ref" IS NULL AND "criterion_verdicts"."design_workflow_id" IS NULL AND "criterion_verdicts"."design_revision" IS NULL AND "criterion_verdicts"."contract_ref" IS NULL AND "criterion_verdicts"."contract_version" IS NULL)
        OR ("criterion_verdicts"."identity_kind" = 'runtime' AND "criterion_verdicts"."runtime_ref" ~ '^[0-9a-f]{40,64}$' AND "criterion_verdicts"."commit_sha" IS NULL AND "criterion_verdicts"."design_workflow_id" IS NULL AND "criterion_verdicts"."design_revision" IS NULL AND "criterion_verdicts"."contract_ref" IS NULL AND "criterion_verdicts"."contract_version" IS NULL)
        OR ("criterion_verdicts"."identity_kind" = 'design' AND "criterion_verdicts"."design_workflow_id" IS NOT NULL AND "criterion_verdicts"."design_revision" >= 1 AND "criterion_verdicts"."commit_sha" IS NULL AND "criterion_verdicts"."runtime_ref" IS NULL AND "criterion_verdicts"."contract_ref" IS NULL AND "criterion_verdicts"."contract_version" IS NULL)
        OR ("criterion_verdicts"."identity_kind" = 'contract' AND "criterion_verdicts"."contract_ref" ~ '[^[:space:]]' AND "criterion_verdicts"."contract_version" ~ '[^[:space:]]' AND "criterion_verdicts"."commit_sha" IS NULL AND "criterion_verdicts"."runtime_ref" IS NULL AND "criterion_verdicts"."design_workflow_id" IS NULL AND "criterion_verdicts"."design_revision" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "issue_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"statement" text NOT NULL,
	"position" integer NOT NULL,
	"requirement_criterion_id" uuid,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_criteria_n_chk" CHECK ("issue_criteria"."n" >= 1),
	CONSTRAINT "issue_criteria_statement_chk" CHECK ("issue_criteria"."statement" ~ '[^[:space:]]')
);
--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_criterion_id_issue_criteria_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."issue_criteria"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_design_workflow_id_project_workflows_id_fk" FOREIGN KEY ("design_workflow_id") REFERENCES "public"."project_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_criteria" ADD CONSTRAINT "issue_criteria_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_criteria" ADD CONSTRAINT "issue_criteria_requirement_criterion_fk" FOREIGN KEY ("requirement_criterion_id") REFERENCES "public"."requirement_criteria"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "criterion_verdicts_latest_idx" ON "criterion_verdicts" USING btree ("criterion_id","created_at");--> statement-breakpoint
CREATE INDEX "criterion_verdicts_issue_idx" ON "criterion_verdicts" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_criteria_live_n_uq" ON "issue_criteria" USING btree ("issue_id","n") WHERE retired_at IS NULL;--> statement-breakpoint
CREATE INDEX "issue_criteria_issue_idx" ON "issue_criteria" USING btree ("issue_id","position");