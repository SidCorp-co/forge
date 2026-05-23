-- ISS-196 — Transactional outbox + AFTER UPDATE trigger on issues.status.
--
-- Every committed UPDATE of issues.status inserts exactly one outbox row in
-- the same transaction (trigger is the sole producer). The outbox-worker
-- drains pipeline_outbox and re-emits the `transition` hook out-of-band so
-- a process crash mid-emit, manual PATCH, raw SQL UPDATE, or any other
-- code path that touches issues.status still reaches the orchestrator.
--
-- Actor metadata is carried through Postgres session settings
-- (`pipeline.actor_id`, `pipeline.actor_type`, `pipeline.reason`) which the
-- app sets via SET LOCAL inside the same transaction. Raw psql UPDATEs that
-- skip set_config fall through with actor_id=NULL, actor_type='system'.
--
-- Reversible: DROP TRIGGER + DROP FUNCTION + DROP TABLE.

CREATE TABLE "pipeline_outbox" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "issue_id"      uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "project_id"    uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "from_status"   text NOT NULL,
  "to_status"     text NOT NULL,
  "actor_id"      text,
  "actor_type"    text,
  "reason"        text,
  "payload"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "processed_at"  timestamptz,
  "attempts"      integer NOT NULL DEFAULT 0,
  "last_error"    text
);--> statement-breakpoint

CREATE INDEX "idx_outbox_unprocessed"
  ON "pipeline_outbox" ("created_at")
  WHERE "processed_at" IS NULL;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pipeline_outbox_on_status_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO pipeline_outbox (
      issue_id, project_id, from_status, to_status,
      actor_id, actor_type, reason
    ) VALUES (
      NEW.id,
      NEW.project_id,
      OLD.status,
      NEW.status,
      nullif(current_setting('pipeline.actor_id', true), ''),
      coalesce(nullif(current_setting('pipeline.actor_type', true), ''), 'system'),
      nullif(current_setting('pipeline.reason', true), '')
    );
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_issues_status_outbox ON issues;--> statement-breakpoint

CREATE TRIGGER trg_issues_status_outbox
  AFTER UPDATE OF status ON issues
  FOR EACH ROW
  EXECUTE FUNCTION pipeline_outbox_on_status_change();
