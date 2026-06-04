-- ISS-381 (Part 2, unit 2.3) — runner status-change audit.
--
-- Only `runners.status` (current) + `updated_at` are stored today, so the
-- online→offline timeline / runner-uptime chart (ISS-379) is not derivable. Each
-- actual status transition appends one row here, written change-gated at every
-- runners.status mutation site (PATCH / exclude / include / device-heartbeat /
-- stale-detector / bind) so a steady-state heartbeat does not flood the table.
--
-- old_status is nullable so the initial bind insert (no prior status) can record
-- a creation event. reason is a free-text source tag (operator_exclude,
-- device_heartbeat, stale, bind, ...).
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta snapshot
-- collision (see 0087-0095 headers). The runtime migrator applies this row from
-- _journal.json.

CREATE TABLE IF NOT EXISTS "runner_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "runner_id" uuid NOT NULL REFERENCES "runners"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "old_status" text,
  "new_status" text NOT NULL,
  "reason" text,
  "ts" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "runner_events_runner_ts_idx"
  ON "runner_events" ("runner_id", "ts");

CREATE INDEX IF NOT EXISTS "runner_events_project_ts_idx"
  ON "runner_events" ("project_id", "ts");
