-- A runner row is born at its setup machine's initial state, `queued` (REQ-12 BC-17).
--
-- runners.provision_status was nullable, and `POST /api/runners` made its row with NULL there. The
-- setup machine (`@forge/contracts/runner-machine:RUNNER_PROVISION_MACHINE`) has no edge out of
-- NULL, so the kernel transition matched no row and moved nothing: a box's setup report and a
-- re-bind through `POST /api/projects/:id/runners` each answered success while the row stayed
-- NULL, and its box was never given the provision to run.
--
-- A NULL row has never been set up, which is exactly `queued`: each is moved there, the move
-- recorded in kernel_transitions under machine version 1 as the kernel transition records one, and
-- its provision_requested_at set when it had none. The column then defaults to `queued` and
-- refuses NULL. Nothing is deleted.
--
-- ROLLBACK: drop the NOT NULL and the default. The rows moved here stay `queued`.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $$
DECLARE
  prior text := current_setting('forge.kernel_txn', true);
BEGIN
  PERFORM set_config('forge.kernel_txn', txid_current()::text, true);
  WITH moved AS (
    UPDATE runners
       SET provision_status = 'queued',
           provision_requested_at = coalesce(provision_requested_at, now())
     WHERE provision_status IS NULL
    RETURNING id
  )
  INSERT INTO kernel_transitions
    (entity, entity_id, from_status, to_status, machine_version, reason, actor_type, actor_agency, source)
  SELECT 'runner_provision', id, NULL, 'queued', 1,
         'born with no setup status; queued is the state it was never moved out of',
         'system', 'agent', 'migration'
    FROM moved;
  PERFORM set_config('forge.kernel_txn', coalesce(prior, ''), true);
END $$;--> statement-breakpoint
ALTER TABLE "runners" ALTER COLUMN "provision_status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "runners" ALTER COLUMN "provision_status" SET NOT NULL;
