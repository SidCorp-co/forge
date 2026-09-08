CREATE TABLE "question_waiters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "question_waiters" ADD CONSTRAINT "question_waiters_question_id_agent_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."agent_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_waiters_question_idx" ON "question_waiters" USING btree ("question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "question_waiters_run_idx" ON "question_waiters" USING btree ("question_id","device_id","run_id");