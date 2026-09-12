CREATE TABLE "rocketchat_comment_mirror_state" (
	"only" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"since" timestamp with time zone NOT NULL,
	CONSTRAINT "rcq_mirror_state_one_row_chk" CHECK ("rocketchat_comment_mirror_state"."only")
);
--> statement-breakpoint
CREATE TABLE "rocketchat_comment_mirrors" (
	"comment_id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"external_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rocketchat_question_threads" DROP CONSTRAINT "rocketchat_question_threads_pkey";--> statement-breakpoint
ALTER TABLE "rocketchat_question_threads" ALTER COLUMN "question_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "rocketchat_question_threads" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "rocketchat_question_threads" ADD COLUMN "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "rocketchat_question_threads" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rocketchat_comment_mirrors" ADD CONSTRAINT "rocketchat_comment_mirrors_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rocketchat_comment_mirrors" ADD CONSTRAINT "rocketchat_comment_mirrors_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rcq_mirrors_external_idx" ON "rocketchat_comment_mirrors" USING btree ("connection_id","external_message_id");--> statement-breakpoint
CREATE INDEX "rcq_mirrors_status_idx" ON "rocketchat_comment_mirrors" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "rocketchat_question_threads" ADD CONSTRAINT "rocketchat_question_threads_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rcq_threads_question_idx" ON "rocketchat_question_threads" USING btree ("question_id") WHERE question_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rcq_threads_issue_live_idx" ON "rocketchat_question_threads" USING btree ("issue_id") WHERE issue_id IS NOT NULL AND retired_at IS NULL;--> statement-breakpoint
ALTER TABLE "rocketchat_question_threads" ADD CONSTRAINT "rcq_threads_subject_chk" CHECK (num_nonnulls("rocketchat_question_threads"."question_id", "rocketchat_question_threads"."issue_id") = 1);--> statement-breakpoint
INSERT INTO "rocketchat_comment_mirror_state" ("only", "since") VALUES (true, now()) ON CONFLICT DO NOTHING;
