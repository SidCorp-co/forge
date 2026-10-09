-- The intake assistant drafts every requirement and feedback item as it is created, with no chat
-- (REQ-34 BC-10..BC-16, ISS-455; feedback-triage r16 `intake`/`suggest`, requirement-lifecycle r15
-- `start`/`draft`). `intake_drafts` keeps one draft per item: what it named, filled and asked, what
-- it was written as, or the code it could not be drafted under. A requirement's creation is a new
-- outbox event (`requirement.created`), which the intake consumer reads beside `feedback.filed`.
--
-- ROLLBACK: DROP TABLE "intake_drafts"; DELETE FROM "pipeline_outbox" WHERE "type" =
-- 'requirement.created'; DELETE FROM "outbox_event_types" WHERE "type" = 'requirement.created'.
-- Items then show no draft, and a requirement's creation tells nobody.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intake_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "requirement_id" uuid REFERENCES "requirements"("id") ON DELETE cascade,
  "feedback_id" uuid REFERENCES "feedback"("id") ON DELETE cascade,
  "outcome" text NOT NULL,
  "code" text,
  "detail" text,
  "model" text,
  "attempts" integer DEFAULT 1 NOT NULL,
  "read" jsonb NOT NULL,
  "body" jsonb,
  "applied" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "drafted_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "intake_drafts_arc_chk" CHECK (num_nonnulls("intake_drafts"."requirement_id", "intake_drafts"."feedback_id") = 1),
  CONSTRAINT "intake_drafts_outcome_chk" CHECK ("intake_drafts"."outcome" IN ('drafted', 'failed')),
  CONSTRAINT "intake_drafts_code_chk" CHECK ("intake_drafts"."code" IS NULL OR "intake_drafts"."code" IN ('INTAKE_MODEL_UNCONFIGURED', 'INTAKE_WITHHELD', 'INTAKE_MODEL_FAILED', 'INTAKE_SHAPE')),
  CONSTRAINT "intake_drafts_shape_chk" CHECK (("intake_drafts"."outcome" = 'drafted' AND "intake_drafts"."code" IS NULL AND jsonb_typeof("intake_drafts"."body") = 'object') OR ("intake_drafts"."outcome" = 'failed' AND "intake_drafts"."code" IS NOT NULL AND "intake_drafts"."body" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "intake_drafts_requirement_uq" ON "intake_drafts" ("requirement_id") WHERE requirement_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "intake_drafts_feedback_uq" ON "intake_drafts" ("feedback_id") WHERE feedback_id IS NOT NULL;--> statement-breakpoint
INSERT INTO "outbox_event_types" ("type") VALUES ('requirement.created') ON CONFLICT DO NOTHING;
