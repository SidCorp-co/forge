-- A request passes one value check before it becomes a requirement or open feedback (ISS-690,
-- REQ-65 BC-1..BC-6, REQ-66 BC-2).
--
-- requirements: `refused` joins the statuses, machine `requirement` version 6. The value check moves a
-- draft there with its one-line reason (the kernel_transitions row of the move holds it), and a person
-- moves it back to draft with a one-line reason of their own. requirements_told_step_chk widens with
-- it, since a refused requirement's author is told that step.
-- intake_drafts: `value` is the item's value check (who, what improves, how it is measured, what it
-- repeats, and how it ended) and `value_outcome` how it ended, `held` while a blocking question stands;
-- both NULL on a draft made before the check and on one that failed. `kept_*` is the person who kept
-- a refused requirement, why and when, all set or all NULL.
-- intake_answers: a person's answer to one question of an item's draft, by its number, with the
-- question and the option's label as they were asked, so an answer outlives the draft that asked it.
-- `asked_at` is the drafted_at of the draft that asked it.
-- intake.answered is an outbox event type: an answer to the last question holding a check writes one,
-- and its one consumer, `intake-assistant`, drafts the item again with the answers.
--
-- Nothing is backfilled: every existing draft reads as made before the check, and every existing
-- requirement keeps its status.
--
-- ROLLBACK: once no requirement reads refused (move each back to draft through the kernel), restore
-- the seven-status requirements_status_chk and requirements_told_step_chk; drop intake_answers, losing
-- every answer given; drop intake_drafts.value, .value_outcome and .kept_*, losing every value check
-- and every keep; DELETE FROM outbox_event_types WHERE type = 'intake.answered', once no
-- pipeline_outbox row names it.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "requirements" DROP CONSTRAINT IF EXISTS "requirements_status_chk";--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_status_chk" CHECK ("requirements"."status" IN ('draft', 'agreed', 'in_delivery', 'delivered', 'accepted', 'dropped', 'deferred', 'refused'));--> statement-breakpoint
ALTER TABLE "requirements" DROP CONSTRAINT IF EXISTS "requirements_told_step_chk";--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_told_step_chk" CHECK ("requirements"."told_step" IS NULL OR "requirements"."told_step" IN ('draft', 'agreed', 'in_delivery', 'delivered', 'accepted', 'deferred', 'dropped', 'refused'));--> statement-breakpoint
ALTER TABLE "intake_drafts" ADD COLUMN IF NOT EXISTS "value" jsonb;--> statement-breakpoint
ALTER TABLE "intake_drafts" ADD COLUMN IF NOT EXISTS "value_outcome" text;--> statement-breakpoint
ALTER TABLE "intake_drafts" ADD COLUMN IF NOT EXISTS "kept_reason" text;--> statement-breakpoint
ALTER TABLE "intake_drafts" ADD COLUMN IF NOT EXISTS "kept_by" uuid;--> statement-breakpoint
ALTER TABLE "intake_drafts" ADD COLUMN IF NOT EXISTS "kept_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "intake_drafts" DROP CONSTRAINT IF EXISTS "intake_drafts_kept_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "intake_drafts" ADD CONSTRAINT "intake_drafts_kept_by_users_id_fk" FOREIGN KEY ("kept_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_drafts" DROP CONSTRAINT IF EXISTS "intake_drafts_value_outcome_chk";--> statement-breakpoint
ALTER TABLE "intake_drafts" ADD CONSTRAINT "intake_drafts_value_outcome_chk" CHECK ("intake_drafts"."value_outcome" IS NULL OR "intake_drafts"."value_outcome" IN ('accept', 'merge', 'alternative', 'refuse', 'held'));--> statement-breakpoint
ALTER TABLE "intake_drafts" DROP CONSTRAINT IF EXISTS "intake_drafts_value_chk";--> statement-breakpoint
ALTER TABLE "intake_drafts" ADD CONSTRAINT "intake_drafts_value_chk" CHECK (("intake_drafts"."value" IS NULL) = ("intake_drafts"."value_outcome" IS NULL) AND ("intake_drafts"."value" IS NULL OR "intake_drafts"."outcome" = 'drafted'));--> statement-breakpoint
ALTER TABLE "intake_drafts" DROP CONSTRAINT IF EXISTS "intake_drafts_kept_chk";--> statement-breakpoint
ALTER TABLE "intake_drafts" ADD CONSTRAINT "intake_drafts_kept_chk" CHECK (("intake_drafts"."kept_reason" IS NULL) = ("intake_drafts"."kept_at" IS NULL) AND ("intake_drafts"."kept_reason" IS NULL OR "intake_drafts"."kept_reason" ~ '[^[:space:]]'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intake_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"asked_at" timestamp with time zone NOT NULL,
	"question" integer NOT NULL,
	"prompt" text NOT NULL,
	"option_id" text NOT NULL,
	"label" text NOT NULL,
	"answered_by" uuid,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_answers_question_chk" CHECK ("intake_answers"."question" BETWEEN 1 AND 3)
);--> statement-breakpoint
ALTER TABLE "intake_answers" DROP CONSTRAINT IF EXISTS "intake_answers_draft_id_intake_drafts_id_fk";--> statement-breakpoint
ALTER TABLE "intake_answers" ADD CONSTRAINT "intake_answers_draft_id_intake_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."intake_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_answers" DROP CONSTRAINT IF EXISTS "intake_answers_answered_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "intake_answers" ADD CONSTRAINT "intake_answers_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "intake_answers_question_uq" ON "intake_answers" USING btree ("draft_id","asked_at","question");--> statement-breakpoint
INSERT INTO "outbox_event_types" ("type") VALUES ('intake.answered') ON CONFLICT DO NOTHING;
