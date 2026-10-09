-- A gated move records every gate it passed, and a refused one names the gate that refused it
-- (REQ-34 BC-8, BC-9). A gate is a checklist or a move check (`@forge/contracts/move-gates`).
--
-- kernel_transitions.gates: the gates the edge taken asked, written on every move from now on,
-- empty on an edge asking none. A row recorded before holds NULL and reads "no checklist" against a
-- gate it did not record; nothing is backfilled, because nothing recorded which gates judged it.
-- kernel_refused_moves.checklist and checklist_version are renamed gate and gate_version: every row
-- already there was refused by a checklist, whose id is its gate's id, so each keeps its meaning.
--
-- ROLLBACK: drop kernel_transitions.gates with its constraint, and rename kernel_refused_moves.gate
-- and gate_version back to checklist and checklist_version; the gates passed moves recorded are then
-- gone, and a refused row naming a move check would name a checklist no registry holds.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "kernel_transitions" ADD COLUMN IF NOT EXISTS "gates" text[];--> statement-breakpoint
ALTER TABLE "kernel_transitions" DROP CONSTRAINT IF EXISTS "kernel_transitions_gates_chk";--> statement-breakpoint
ALTER TABLE "kernel_transitions" ADD CONSTRAINT "kernel_transitions_gates_chk" CHECK ("checklist" IS NULL OR "gates" IS NULL OR "checklist" = ANY("gates"));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'kernel_refused_moves' AND column_name = 'checklist'
  ) THEN
    ALTER TABLE "kernel_refused_moves" RENAME COLUMN "checklist" TO "gate";
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'kernel_refused_moves' AND column_name = 'checklist_version'
  ) THEN
    ALTER TABLE "kernel_refused_moves" RENAME COLUMN "checklist_version" TO "gate_version";
  END IF;
END $$;
