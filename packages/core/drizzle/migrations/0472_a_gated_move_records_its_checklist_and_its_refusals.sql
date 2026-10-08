-- A gated move records the checklist that judged it (REQ-34 BC-3, BC-9), and a refused one is kept.
--
-- kernel_transitions: `checklist`, `checklist_version` and `checklist_answers` (each answer given or
-- assumed, with its source) are written on a move along an edge that names a checklist. A row
-- recorded before checklists existed holds NULL in all three and reads "no checklist"; nothing is
-- backfilled, because no checklist judged it.
-- kernel_refused_moves: one row per refused move along such an edge, with the refusals it answered.
--
-- ROLLBACK: drop table kernel_refused_moves, and drop kernel_transitions.checklist_answers,
-- checklist_version and checklist with their constraint; the refused moves and the answers moves
-- recorded are then gone.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "kernel_transitions" ADD COLUMN IF NOT EXISTS "checklist" text;--> statement-breakpoint
ALTER TABLE "kernel_transitions" ADD COLUMN IF NOT EXISTS "checklist_version" integer;--> statement-breakpoint
ALTER TABLE "kernel_transitions" ADD COLUMN IF NOT EXISTS "checklist_answers" jsonb;--> statement-breakpoint
ALTER TABLE "kernel_transitions" DROP CONSTRAINT IF EXISTS "kernel_transitions_checklist_chk";--> statement-breakpoint
ALTER TABLE "kernel_transitions" ADD CONSTRAINT "kernel_transitions_checklist_chk" CHECK (("checklist" IS NULL AND "checklist_version" IS NULL AND "checklist_answers" IS NULL) OR ("checklist" IS NOT NULL AND "checklist_version" >= 1 AND jsonb_typeof("checklist_answers") = 'array'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kernel_refused_moves" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "from_status" text NOT NULL,
  "to_status" text NOT NULL,
  "machine_version" integer NOT NULL,
  "checklist" text NOT NULL,
  "checklist_version" integer NOT NULL,
  "refusals" jsonb NOT NULL,
  "actor_type" text NOT NULL,
  "actor_agency" text NOT NULL,
  "actor_id" uuid,
  "actor_token_id" uuid,
  "actor_on_behalf_of" uuid,
  "source" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "kernel_refused_moves_refusals_chk" CHECK (jsonb_typeof("refusals") = 'array' AND jsonb_array_length("refusals") >= 1)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kernel_refused_moves_entity_idx" ON "kernel_refused_moves" ("entity","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kernel_refused_moves_created_at_idx" ON "kernel_refused_moves" ("created_at");
