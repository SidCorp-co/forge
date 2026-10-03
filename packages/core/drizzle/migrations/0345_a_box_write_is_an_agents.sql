-- Who acted is recorded, never defaulted. A write made with a token bound to a paired box is that
-- box's, so an agent's, with the person holding the token kept as the principal.
--
-- `actor_agency` loses its 'human' default on both audit tables: a row that does not say who acted
-- is refused by the database instead of being written as a person.
ALTER TABLE "activity_log" ALTER COLUMN "actor_agency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "kernel_transitions" ALTER COLUMN "actor_agency" DROP DEFAULT;--> statement-breakpoint

-- The I1 orphan trigger wrote its `system` audit row through that default, so every one says a
-- person cancelled the job. A machine actor is an agent (`lifecycle/transition.ts:agencyOf`): the
-- trigger names it from here on, and the rows the default wrote are corrected. The body is 0180's,
-- the live one, with only the audit INSERT changed.
CREATE OR REPLACE FUNCTION "enforce_no_active_child_under_terminal_run"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_status text;
  child_active boolean;
  prev_status text;
  terminal_status text;
BEGIN
  IF NEW.pipeline_run_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'jobs' THEN
    child_active := NEW.status IN ('queued', 'dispatched', 'running', 'held');
    terminal_status := 'cancelled';
  ELSIF TG_TABLE_NAME = 'agent_sessions' THEN
    child_active := NEW.status IN ('idle', 'queued', 'running');
    terminal_status := 'cancelled_stale';
  ELSE
    RETURN NEW;
  END IF;

  IF NOT child_active THEN
    RETURN NEW;
  END IF;

  SELECT status INTO run_status FROM pipeline_runs WHERE id = NEW.pipeline_run_id;

  IF run_status IS NULL OR run_status IN ('running', 'paused') THEN
    RETURN NEW;
  END IF;

  prev_status := NEW.status;

  INSERT INTO "kernel_transitions"
    ("entity", "entity_id", "from_status", "to_status", "reason", "actor_type", "actor_agency", "actor_id", "source")
  VALUES
    (CASE WHEN TG_TABLE_NAME = 'jobs' THEN 'job' ELSE 'session' END,
     NEW.id, prev_status, terminal_status, 'orphan_under_terminal_run',
     'system', 'agent', NULL, 'i1_trigger');

  IF TG_TABLE_NAME = 'jobs' THEN
    NEW.status := 'cancelled';
    NEW.failure_kind := 'infra';
    NEW.failure_reason := 'orphan_under_terminal_run';
    NEW.cancellation_requested := true;
    NEW.finished_at := COALESCE(NEW.finished_at, now());
  ELSE
    NEW.status := 'cancelled_stale';
    NEW.failure_reason := 'orphan_under_terminal_run';
    NEW.updated_at := now();
  END IF;

  RAISE LOG 'I1 alarm: %=% (was %) auto-cancelled under terminal pipeline_run % (run status=%); reason=orphan_under_terminal_run',
    TG_TABLE_NAME, NEW.id, prev_status, NEW.pipeline_run_id, run_status;

  RETURN NEW;
END;
$$;--> statement-breakpoint
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE kernel_transitions SET actor_agency = 'agent'
  WHERE actor_type IN ('system', 'runner', 'sweeper') AND actor_agency = 'human';
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE '0345: % machine-actor kernel_transitions row(s) the human default wrote now say agent', n;
END;
$$;--> statement-breakpoint

-- The box whose credential filed an issue, beside its holder in `created_by_id` — the mark
-- `comments.author_device_id` already gives a comment.
ALTER TABLE "issues" ADD COLUMN "created_by_device_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_created_by_device_id_devices_id_fk" FOREIGN KEY ("created_by_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- A status change carries its actor's agency through the outbox, so the activity row the worker
-- writes says who acted rather than re-deriving it from the account (which reads a box as its
-- holder). A `user` row without one is refused from here on; history is left as it was written.
ALTER TABLE "pipeline_outbox" ADD COLUMN "actor_agency" text;--> statement-breakpoint
DO $$
DECLARE
  stray record;
BEGIN
  UPDATE pipeline_outbox o SET actor_agency = u.kind
  FROM users u
  WHERE o.processed_at IS NULL AND o.actor_type = 'user' AND u.id::text = o.actor_id;
  SELECT id, actor_id INTO stray FROM pipeline_outbox
  WHERE processed_at IS NULL AND actor_type = 'user' AND actor_agency IS NULL
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'pipeline_outbox row % is an undelivered user transition whose actor % is not an account, so who acted cannot be carried; deliver or remove it and deploy again',
      stray.id, coalesce(stray.actor_id, 'NULL');
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_user_actor_has_agency"
  CHECK (CASE WHEN actor_agency IS NULL THEN actor_type IS DISTINCT FROM 'user' ELSE actor_agency IN ('human', 'agent') END)
  NOT VALID;--> statement-breakpoint

CREATE OR REPLACE FUNCTION pipeline_outbox_on_status_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO pipeline_outbox (
      issue_id, project_id, from_status, to_status,
      actor_id, actor_type, actor_agency, reason
    ) VALUES (
      NEW.id,
      NEW.project_id,
      OLD.status,
      NEW.status,
      nullif(current_setting('pipeline.actor_id', true), ''),
      coalesce(nullif(current_setting('pipeline.actor_type', true), ''), 'system'),
      nullif(current_setting('pipeline.actor_agency', true), ''),
      nullif(current_setting('pipeline.reason', true), '')
    );
  END IF;
  RETURN NEW;
END;
$$;
