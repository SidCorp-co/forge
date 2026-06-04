-- ISS-381 (Part 2, unit 2.2) — queue-depth snapshots.
--
-- No history table exists for instantaneous queue depth (only wait-time is
-- derivable, shipped by ISS-380). The pipeline sweeper (runPipelineSweep, every
-- minute) writes one row per project with at least one active job, so
-- queue-depth-over-time becomes chartable for the ISS-379 dashboard.
--
-- Sparse by design: a project with no active jobs in a tick gets no row; the
-- read (timeseries metric=queue_depth) gap-fills missing buckets as 0.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta snapshot
-- collision (see 0087-0094 headers). The runtime migrator applies this row from
-- _journal.json.

CREATE TABLE IF NOT EXISTS "queue_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "ts" timestamp with time zone NOT NULL DEFAULT now(),
  "queue_depth" integer NOT NULL,
  "running_count" integer NOT NULL,
  "avg_wait_ms" bigint
);

CREATE INDEX IF NOT EXISTS "queue_snapshots_project_ts_idx"
  ON "queue_snapshots" ("project_id", "ts");
