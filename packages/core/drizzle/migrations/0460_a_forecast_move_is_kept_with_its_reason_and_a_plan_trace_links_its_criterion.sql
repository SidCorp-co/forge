-- A forecast is anchored on the last event its facts moved on, and each anchor a read meets is kept
-- once in `forecast_moves` with the range it gave, so a date that moves names the event that moved
-- it (HOP REQ-7: 12:28 to 14:34 in 28 minutes, with no reason shown).
--
-- And the trace a plan wrote into a criterion's own words is linked. The text path
-- (`issues/criteria/store.ts:syncCriteriaFromText`) carried no `requirement_criterion_id`, so a
-- criterion opening `(REQ-25 BC-1) …` proved nothing for REQ-25 BC-1: 170 live HOP criteria. Each
-- live, unlinked criterion opening with exactly one `(REQ-<n> BC-<m>)` is linked to the wording of
-- BC-<m> live at the revision its issue was planned against (its requirement's current one where the
-- issue records none). Nothing is guessed: a tag naming another requirement than its issue's, an
-- issue with no requirement, or a code with no single live wording aborts the migration naming the
-- row. Idempotent: a linked criterion is never a candidate again. A tag of another shape (one naming
-- two codes) is not a single trace and stays unlinked; the write path refuses that shape from now on.
--
-- ROLLBACK: DROP TABLE forecast_moves; the links stay, each one a trace its criterion's words state.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "forecast_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"anchored_at" timestamp with time zone NOT NULL,
	"p50_at" timestamp with time zone NOT NULL,
	"p85_at" timestamp with time zone NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forecast_moves_order_chk" CHECK ("forecast_moves"."p85_at" >= "forecast_moves"."p50_at"),
	CONSTRAINT "forecast_moves_event_chk" CHECK (jsonb_typeof("forecast_moves"."event") = 'object')
);
--> statement-breakpoint
ALTER TABLE "forecast_moves" DROP CONSTRAINT IF EXISTS "forecast_moves_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "forecast_moves" ADD CONSTRAINT "forecast_moves_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "forecast_moves_anchor_uq" ON "forecast_moves" USING btree ("project_id","scope","anchored_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forecast_moves_scope_idx" ON "forecast_moves" USING btree ("project_id","scope","anchored_at");--> statement-breakpoint
DO $$
DECLARE
  bad record;
BEGIN
  CREATE TEMP TABLE criterion_traces ON COMMIT DROP AS
  SELECT c.id AS criterion_id, c.issue_id, c.n, t.tag[1]::int AS req_seq, t.tag[2] AS code,
         r.req_seq AS own_seq, coalesce(i.planned_revision, r.current_revision) AS revision,
         (SELECT array_agg(rc.id) FROM requirement_criteria rc
           WHERE rc.requirement_id = i.requirement_id AND rc.code = t.tag[2]
             AND rc.since_revision <= coalesce(i.planned_revision, r.current_revision)
             AND (rc.retired_revision IS NULL OR rc.retired_revision > coalesce(i.planned_revision, r.current_revision))) AS wordings
    FROM issue_criteria c
    JOIN issues i ON i.id = c.issue_id
    LEFT JOIN requirements r ON r.id = i.requirement_id
   CROSS JOIN LATERAL (SELECT regexp_match(c.statement, '^\s*\(REQ-([0-9]+) (BC-[0-9]+)\)') AS tag) t
   WHERE c.retired_at IS NULL AND c.requirement_criterion_id IS NULL AND t.tag IS NOT NULL;
  SELECT * INTO bad FROM criterion_traces
   WHERE own_seq IS NULL OR own_seq <> req_seq OR coalesce(array_length(wordings, 1), 0) <> 1
   ORDER BY issue_id, n LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'CRITERION_TRACE_UNMAPPABLE: issue % criterion % says (REQ-% %), and %', bad.issue_id, bad.n, bad.req_seq, bad.code,
      CASE WHEN bad.own_seq IS NULL THEN 'its issue serves no requirement'
           WHEN bad.own_seq <> bad.req_seq THEN format('its issue serves REQ-%s', bad.own_seq)
           ELSE format('REQ-%s holds %s wordings of %s live at revision %s, not one', bad.own_seq, coalesce(array_length(bad.wordings, 1), 0), bad.code, bad.revision) END
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE issue_criteria c SET requirement_criterion_id = t.wordings[1]
    FROM criterion_traces t WHERE c.id = t.criterion_id;
END $$;
