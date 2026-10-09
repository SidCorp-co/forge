-- A verdict keeps the probe it rests on (REQ-36 BC-6, BC-12; ISS-469). `criterion_probes` holds each
-- probe kept on a criterion: a stored, replayable exercise of the running build (an HTTP request or a
-- command) and the result it expects, as the verdict door validated it, never a credential. Rows
-- are insert-only; a criterion's newest probe is its kept one. `criterion_verdicts.probe_id` names
-- the probe a verdict rests on. The guard holds a probe's criterion to its issue and a verdict's
-- probe to the verdict's own criterion. Rows before this change keep `probe_id` null.
--
-- ROLLBACK: ALTER TABLE "criterion_verdicts" DROP COLUMN "probe_id"; DROP TABLE "criterion_probes";
-- DROP FUNCTION criterion_probe_guard(). Every kept probe is lost, and no verdict says what it rests
-- on any more.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "criterion_probes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criterion_id" uuid NOT NULL REFERENCES "issue_criteria"("id") ON DELETE cascade,
	"issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "criterion_probes_kind_chk" CHECK ("kind" IN ('request', 'command')),
	CONSTRAINT "criterion_probes_spec_chk" CHECK (jsonb_typeof("spec") = 'object' AND "spec"->>'kind' = "kind" AND octet_length("spec"::text) <= 64000)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "criterion_probes_kept_idx" ON "criterion_probes" ("criterion_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "criterion_probes_issue_idx" ON "criterion_probes" ("issue_id");--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD COLUMN IF NOT EXISTS "probe_id" uuid REFERENCES "criterion_probes"("id") ON DELETE restrict;--> statement-breakpoint
CREATE OR REPLACE FUNCTION criterion_probe_guard() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'criterion_probes' THEN
    IF NOT EXISTS (SELECT 1 FROM issue_criteria c WHERE c.id = NEW.criterion_id AND c.issue_id = NEW.issue_id) THEN
      RAISE EXCEPTION 'CRITERION_PROBE_MISMATCH: criterion % is not a criterion of issue %', NEW.criterion_id, NEW.issue_id;
    END IF;
  ELSIF NEW.probe_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM criterion_probes p WHERE p.id = NEW.probe_id AND p.criterion_id = NEW.criterion_id) THEN
    RAISE EXCEPTION 'CRITERION_PROBE_MISMATCH: probe % is not kept on criterion %', NEW.probe_id, NEW.criterion_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "criterion_probes_guard_trg" ON "criterion_probes";--> statement-breakpoint
CREATE TRIGGER "criterion_probes_guard_trg" BEFORE INSERT OR UPDATE ON "criterion_probes"
  FOR EACH ROW EXECUTE FUNCTION criterion_probe_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS "criterion_verdicts_probe_guard_trg" ON "criterion_verdicts";--> statement-breakpoint
CREATE TRIGGER "criterion_verdicts_probe_guard_trg" BEFORE INSERT OR UPDATE OF "probe_id" ON "criterion_verdicts"
  FOR EACH ROW EXECUTE FUNCTION criterion_probe_guard();
