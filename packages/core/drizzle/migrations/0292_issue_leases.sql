-- ISS-1109 — the lease on an issue becomes a row a constraint can refuse.
--
-- Held-ness was derived from `pipeline_runs.metadata -> 'runIssues'`, a jsonb
-- array. No index constrains an array element, so nothing refused the second
-- taker and two boxes could hold one issue. The primary key below is what
-- refuses it. `runIssues` stays as the run's membership record.

CREATE TABLE "issue_leases" (
	"project_id" uuid NOT NULL,
	"issue_key" text NOT NULL,
	"device_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_leases_project_id_issue_key_pk" PRIMARY KEY("project_id","issue_key")
);
--> statement-breakpoint
ALTER TABLE "issue_leases" ADD CONSTRAINT "issue_leases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_leases" ADD CONSTRAINT "issue_leases_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_leases" ADD CONSTRAINT "issue_leases_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_leases" ADD CONSTRAINT "issue_leases_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_leases_session_idx" ON "issue_leases" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "issue_leases_device_idx" ON "issue_leases" USING btree ("device_id");--> statement-breakpoint

-- The rows the new schema cannot represent, named rather than cleaned away.
-- Two live run sessions holding one key is the very state this table exists to
-- make impossible; picking a winner here would delete the evidence that it
-- happened and hand the loser's box an issue it still believes it is running.
-- Stop one of the two boxes and deploy again.
DO $$
DECLARE
	offenders text;
BEGIN
	SELECT string_agg(d.who, E'\n')
	  INTO offenders
	  FROM (
	    SELECT r.project_id || ' ' || k || ' held by sessions ' ||
	           string_agg(s.id::text, ', ' ORDER BY s.id) AS who
	      FROM agent_sessions s
	      JOIN pipeline_runs r ON r.id = s.pipeline_run_id
	      CROSS JOIN LATERAL jsonb_array_elements_text(
	             COALESCE(r.metadata -> 'runIssues', '[]'::jsonb)) AS k
	     WHERE s.metadata->>'type' = 'run_session'
	       AND s.status NOT IN ('completed','failed','completed_via_recovery','cancelled_stale','cancelled')
	     GROUP BY r.project_id, k
	    HAVING count(*) > 1
	  ) AS d;
	IF offenders IS NOT NULL THEN
		RAISE EXCEPTION 'ISS-1109: two live run sessions already hold one issue, so this lease table cannot be built without discarding one of them. Stop one box per line below and deploy again.%s', E'\n' || offenders;
	END IF;
END $$;--> statement-breakpoint

-- Carry every lease a live run session is holding right now. Without this the
-- table starts empty and every issue being worked at the moment of the deploy
-- reads as free to the next box that asks.
INSERT INTO "issue_leases" (project_id, issue_key, device_id, session_id, run_id, acquired_at)
SELECT r.project_id, k, s.device_id, s.id, r.id, COALESCE(s.started_at, s.created_at)
  FROM agent_sessions s
  JOIN pipeline_runs r ON r.id = s.pipeline_run_id
  CROSS JOIN LATERAL jsonb_array_elements_text(
         COALESCE(r.metadata -> 'runIssues', '[]'::jsonb)) AS k
 WHERE s.metadata->>'type' = 'run_session'
   AND s.device_id IS NOT NULL
   AND s.status NOT IN ('completed','failed','completed_via_recovery','cancelled_stale','cancelled')
ON CONFLICT (project_id, issue_key) DO NOTHING;
