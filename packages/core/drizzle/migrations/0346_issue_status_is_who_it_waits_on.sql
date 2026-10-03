-- ISS-54 — an issue's status says only who it is waiting on (workflow `issue-lifecycle`, approved
-- revision 2): ten statuses replace seventeen, and a run's step moves into `issue_work_state`.
--
-- Every existing row is mapped by the one table below and by nothing else. A row whose status
-- (or park kind) the table cannot say aborts the migration, naming the row: nothing is guessed,
-- and nothing is deleted to make the data fit.
--
--   old status        → status            step      legacy_status (cm:hack, read back by
--                                                                 forge-plugin 3.36.542)
--   draft             → draft
--   open              → open
--   confirmed         → open
--   clarified         → open
--   approved          → approved
--   in_progress       → in_progress       build
--   developed         → in_progress       test      developed
--   testing           → in_progress       test      testing
--   tested            → awaiting_release            tested
--   awaiting_release  → awaiting_release
--   releasing         → awaiting_release  release   releasing
--   reopen            → reopen
--   waiting           → needs_info  (its waiting_kind kept; a waiting park with none aborts)
--   needs_info        → needs_info  (kind `needs_answer` where it stored none: it asked a question)
--   on_hold           → on_hold
--   closed            → closed
--   dropped           → dropped
--
-- `issues.session_context.lease` moves to `issue_work_state.lease` (the key leaves the blob, so the
-- lease has one home); the branch and head the blob's worklog names are read into typed columns.
-- A park's `left_status` is the status of its newest audited move in from a working status, mapped
-- by the same table; where the audit holds none it stays NULL and a person names where it resumes.
--
-- The status writes are this migration's, not lifecycle moves: they are audited in
-- `kernel_transitions` under source `migration`, and the outbox rows the status trigger mints for
-- them are deleted in this same transaction so no master is woken and nobody is notified.

CREATE TABLE "issue_work_state" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"step" text,
	"step_started_at" timestamp with time zone,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lease" jsonb,
	"lease_holder" text GENERATED ALWAYS AS (nullif(lease ->> 'holder', '')) STORED,
	"branch" text,
	"head_sha" text,
	"left_status" text,
	"legacy_status" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_work_state_step_pair_chk" CHECK (("issue_work_state"."step" IS NULL) = ("issue_work_state"."step_started_at" IS NULL)),
	CONSTRAINT "issue_work_state_step_chk" CHECK ("issue_work_state"."step" IS NULL OR "issue_work_state"."step" IN ('triage', 'clarify', 'plan', 'build', 'test', 'release')),
	CONSTRAINT "issue_work_state_steps_chk" CHECK (jsonb_typeof("issue_work_state"."steps") = 'array'),
	CONSTRAINT "issue_work_state_head_sha_chk" CHECK ("issue_work_state"."head_sha" IS NULL OR "issue_work_state"."head_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "issue_work_state_branch_chk" CHECK ("issue_work_state"."branch" IS NULL OR ("issue_work_state"."branch" ~ '[^[:space:]]' AND char_length("issue_work_state"."branch") <= 255)),
	CONSTRAINT "issue_work_state_left_status_chk" CHECK ("issue_work_state"."left_status" IS NULL OR "issue_work_state"."left_status" IN ('open', 'reopen', 'in_progress', 'approved', 'awaiting_release')),
	CONSTRAINT "issue_work_state_legacy_status_chk" CHECK ("issue_work_state"."legacy_status" IS NULL OR "issue_work_state"."legacy_status" IN ('confirmed', 'clarified', 'developed', 'testing', 'tested', 'releasing'))
);
--> statement-breakpoint
ALTER TABLE "issue_work_state" ADD CONSTRAINT "issue_work_state_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_work_state_lease_holder_idx" ON "issue_work_state" USING btree ("lease_holder") WHERE lease_holder IS NOT NULL;--> statement-breakpoint

-- The mapping, once, as a function the statements below share; dropped at the end.
CREATE FUNCTION "iss54_mapped_status"(old text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE old
    WHEN 'draft' THEN 'draft'
    WHEN 'open' THEN 'open'
    WHEN 'confirmed' THEN 'open'
    WHEN 'clarified' THEN 'open'
    WHEN 'approved' THEN 'approved'
    WHEN 'in_progress' THEN 'in_progress'
    WHEN 'developed' THEN 'in_progress'
    WHEN 'testing' THEN 'in_progress'
    WHEN 'tested' THEN 'awaiting_release'
    WHEN 'awaiting_release' THEN 'awaiting_release'
    WHEN 'releasing' THEN 'awaiting_release'
    WHEN 'reopen' THEN 'reopen'
    WHEN 'waiting' THEN 'needs_info'
    WHEN 'needs_info' THEN 'needs_info'
    WHEN 'on_hold' THEN 'on_hold'
    WHEN 'closed' THEN 'closed'
    WHEN 'dropped' THEN 'dropped'
    ELSE NULL
  END
$$;--> statement-breakpoint

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(id::text || ' at `' || status || '`', ', ' ORDER BY id) INTO bad
    FROM issues WHERE "iss54_mapped_status"(status) IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-54 migration 0346: no mapping for the status of issue(s) %. The ten statuses are draft, open, reopen, in_progress, approved, needs_info, on_hold, awaiting_release, closed, dropped; move each named issue to one of the seventeen this migration maps, then deploy again.', bad;
  END IF;

  SELECT string_agg(id::text, ', ' ORDER BY id) INTO bad
    FROM issues WHERE status = 'waiting' AND waiting_kind IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-54 migration 0346: issue(s) % are parked at `waiting` with no waiting_kind, and `needs_info` keeps the kind a waiting park carried. Set waiting_kind to needs_decision or needs_resource on each named issue, then deploy again.', bad;
  END IF;

  SELECT string_agg(id::text || ' (' || waiting_kind || ')', ', ' ORDER BY id) INTO bad
    FROM issues
   WHERE waiting_kind IS NOT NULL
     AND (waiting_kind NOT IN ('needs_decision', 'needs_resource')
          OR status NOT IN ('waiting', 'needs_info'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-54 migration 0346: issue(s) % carry a waiting_kind outside a park or outside needs_decision/needs_resource, and a kind is held only by a needs_info park now. Clear or correct waiting_kind on each named issue, then deploy again.', bad;
  END IF;
END $$;--> statement-breakpoint

-- This transaction's own status writes are the kernel's: the audit trigger reads this marker and
-- stands aside, and the rows below say what moved and why.
SELECT set_config('forge.kernel_txn', txid_current()::text, true);--> statement-breakpoint
SELECT set_config('pipeline.reason', 'iss54-migration-0346', true);--> statement-breakpoint

INSERT INTO "issue_work_state"
  ("issue_id", "step", "step_started_at", "steps", "lease", "branch", "head_sha", "left_status", "legacy_status")
SELECT
  i.id,
  s.step,
  CASE WHEN s.step IS NULL THEN NULL ELSE i.updated_at END,
  CASE WHEN s.step IS NULL THEN '[]'::jsonb
       ELSE jsonb_build_array(jsonb_build_object('step', s.step, 'startedAt', i.updated_at, 'endedAt', NULL))
  END,
  i.session_context -> 'lease',
  CASE
    WHEN jsonb_typeof(i.session_context -> 'branch') = 'string'
         AND (i.session_context ->> 'branch') ~ '[^[:space:]]'
         AND char_length(i.session_context ->> 'branch') <= 255
      THEN btrim(i.session_context ->> 'branch')
    WHEN jsonb_typeof(i.session_context -> 'worklog' -> 'branch') = 'string'
         AND (i.session_context -> 'worklog' ->> 'branch') ~ '[^[:space:]]'
         AND char_length(i.session_context -> 'worklog' ->> 'branch') <= 255
      THEN btrim(i.session_context -> 'worklog' ->> 'branch')
    ELSE NULL
  END,
  CASE WHEN lower(i.session_context -> 'worklog' ->> 'head') ~ '^[0-9a-f]{40}$'
       THEN lower(i.session_context -> 'worklog' ->> 'head') ELSE NULL END,
  CASE WHEN i.status IN ('waiting', 'needs_info', 'on_hold') THEN (
    SELECT CASE WHEN "iss54_mapped_status"(k.from_status) IN ('open', 'reopen', 'in_progress', 'approved', 'awaiting_release')
                THEN "iss54_mapped_status"(k.from_status) ELSE NULL END
      FROM kernel_transitions k
     WHERE k.entity = 'issue' AND k.entity_id = i.id
       AND k.to_status IN ('waiting', 'needs_info', 'on_hold')
       AND k.from_status IS NOT NULL
       AND k.from_status NOT IN ('waiting', 'needs_info', 'on_hold')
     ORDER BY k.created_at DESC
     LIMIT 1
  ) ELSE NULL END,
  CASE WHEN i.status IN ('developed', 'testing', 'tested', 'releasing') THEN i.status ELSE NULL END
FROM issues i
CROSS JOIN LATERAL (
  SELECT CASE i.status
    WHEN 'in_progress' THEN 'build'
    WHEN 'developed' THEN 'test'
    WHEN 'testing' THEN 'test'
    WHEN 'releasing' THEN 'release'
    ELSE NULL
  END AS step
) s
WHERE s.step IS NOT NULL
   OR i.status IN ('waiting', 'needs_info', 'on_hold', 'tested')
   OR i.session_context ? 'lease'
   OR jsonb_typeof(i.session_context -> 'branch') = 'string'
   OR jsonb_typeof(i.session_context -> 'worklog') = 'object';--> statement-breakpoint

UPDATE issues SET session_context = session_context - 'lease' WHERE session_context ? 'lease';--> statement-breakpoint

INSERT INTO kernel_transitions ("entity", "entity_id", "from_status", "to_status", "reason", "actor_type", "actor_agency", "actor_id", "source")
SELECT 'issue', i.id, i.status, "iss54_mapped_status"(i.status),
       'ISS-54: `' || i.status || '` is retired; the ten-status lifecycle maps it to `' || "iss54_mapped_status"(i.status) || '`',
       'system', 'agent', NULL, 'migration'
  FROM issues i
 WHERE "iss54_mapped_status"(i.status) <> i.status;--> statement-breakpoint

ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_status_chk;--> statement-breakpoint

UPDATE issues
   SET status = "iss54_mapped_status"(status),
       waiting_kind = CASE WHEN status = 'needs_info' AND waiting_kind IS NULL THEN 'needs_answer' ELSE waiting_kind END
 WHERE "iss54_mapped_status"(status) <> status
    OR (status = 'needs_info' AND waiting_kind IS NULL);--> statement-breakpoint

DELETE FROM pipeline_outbox
 WHERE processed_at IS NULL AND reason = 'iss54-migration-0346';--> statement-breakpoint

ALTER TABLE issues ADD CONSTRAINT issues_status_chk
  CHECK (status IN (
    'draft', 'open', 'reopen', 'in_progress', 'approved', 'needs_info', 'on_hold',
    'awaiting_release', 'closed', 'dropped'
  ));--> statement-breakpoint

-- A needs_info park says what it is stopped on, and only a needs_info park holds a kind.
ALTER TABLE issues ADD CONSTRAINT issues_waiting_kind_chk
  CHECK (
    (status = 'needs_info') = (waiting_kind IS NOT NULL)
    AND (waiting_kind IS NULL OR waiting_kind IN ('needs_answer', 'needs_decision', 'needs_resource'))
  );--> statement-breakpoint

-- A knowledge entry's condition names statuses too: each retired name becomes the one it maps to.
ALTER TABLE knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_entries_read_when_chk;--> statement-breakpoint
UPDATE knowledge_entries
   SET read_when = jsonb_set(read_when, '{statuses}', (
         SELECT jsonb_agg(DISTINCT "iss54_mapped_status"(s))
           FROM jsonb_array_elements_text(read_when -> 'statuses') AS s
       ))
 WHERE read_when ? 'statuses'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements_text(read_when -> 'statuses') AS s
      WHERE "iss54_mapped_status"(s) IS DISTINCT FROM s
   );--> statement-breakpoint
CREATE OR REPLACE FUNCTION knowledge_read_when_ok(read_when jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT read_when IS NULL OR (
    jsonb_typeof(read_when) = 'object'
    AND (
      SELECT bool_and(key IN ('verbs', 'statuses'))
      FROM jsonb_object_keys(read_when) AS key
    )
    AND (read_when ? 'verbs' OR read_when ? 'statuses')
    AND (
      NOT (read_when ? 'verbs') OR (
        jsonb_typeof(read_when -> 'verbs') = 'array'
        AND jsonb_array_length(read_when -> 'verbs') > 0
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(read_when -> 'verbs') AS v
          WHERE v NOT IN ('triage', 'dispatch', 'fold', 'judge', 'release', 'park')
        )
      )
    )
    AND (
      NOT (read_when ? 'statuses') OR (
        jsonb_typeof(read_when -> 'statuses') = 'array'
        AND jsonb_array_length(read_when -> 'statuses') > 0
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(read_when -> 'statuses') AS s
          WHERE s NOT IN (
            'draft', 'open', 'reopen', 'in_progress', 'approved', 'needs_info', 'on_hold',
            'awaiting_release', 'closed', 'dropped'
          )
        )
      )
    )
  );
$$;--> statement-breakpoint
ALTER TABLE knowledge_entries ADD CONSTRAINT knowledge_entries_read_when_chk CHECK (knowledge_read_when_ok(read_when));--> statement-breakpoint

-- cm:hack the session context forge-plugin 3.36.542 reads and conditionally writes whole: the
-- row's own blob with the lease put back under the key it was written to. Every reply that
-- carries `sessionContext`, and every `expect` comparison against one, reads it through here.
-- Exit: until forge-plugin moves to the 10-status model (plugin-followups.md), when the lease is
-- read from `issue_work_state` alone and this function is dropped.
CREATE FUNCTION issue_session_context(p_issue uuid, p_context jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN w.lease IS NULL THEN p_context
    ELSE coalesce(p_context, '{}'::jsonb) || jsonb_build_object('lease', w.lease)
  END
  FROM (SELECT (SELECT lease FROM issue_work_state WHERE issue_id = p_issue) AS lease) AS w
$$;--> statement-breakpoint

-- Later migrations in the same run are not this one's to audit or to silence.
SELECT set_config('forge.kernel_txn', '', true);--> statement-breakpoint
SELECT set_config('pipeline.reason', '', true);--> statement-breakpoint

DROP FUNCTION "iss54_mapped_status"(text);
