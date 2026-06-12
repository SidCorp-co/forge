-- ISS-447 (ISS-442 C1, I2) — append-only audit of every terminal status flip on
-- the kernel tables (jobs / agent_sessions / pipeline_runs). One row per flipped
-- entity, written in the same executor as the status UPDATE by the single
-- chokepoint lifecycle/transition.ts:applyKernelTransition. Queryable so C6's
-- interventions/throughput metrics can count by entity/reason/source.
--
-- Hand-written; drizzle-kit generate is blocked by the pre-existing meta
-- snapshot collision (see 0087-0091 headers). The runtime migrator applies this
-- from _journal.json.

CREATE TABLE IF NOT EXISTS "kernel_transitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "from_status" text,
  "to_status" text NOT NULL,
  "reason" text,
  "actor_type" text NOT NULL,
  "actor_id" uuid,
  "source" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "kernel_transitions_entity_idx" ON "kernel_transitions" ("entity","entity_id");
CREATE INDEX IF NOT EXISTS "kernel_transitions_created_at_idx" ON "kernel_transitions" ("created_at");
CREATE INDEX IF NOT EXISTS "kernel_transitions_reason_idx" ON "kernel_transitions" ("reason");
