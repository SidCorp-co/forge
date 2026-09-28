-- ISS-1313 — a project declares what its master is for, in the database.
--
-- `project_master_charters` is append-only: a person's write inserts the next version rather than
-- updating one in place, so the current charter is the highest version and every version a
-- project was ever given stays readable with who wrote it and when. A project with no row here has
-- declared nothing and behaves exactly as it did before this table existed.
--
-- `knowledge_entries.read_when` is a second axis beside `injection`, nullable and additive: every
-- row that exists today reads back with the same body, the same `injection` and no condition.
-- `{ verbs?: string[], statuses?: string[] }` is the whole shape — the verb a master is performing
-- or the board state it is looking at, never a file glob.
--
-- Both shapes are held to their app-level refusal a second time as a Postgres CHECK, so a row the
-- route refuses is a row the column cannot hold. Rollback: see the issue's own "The way back".
CREATE TABLE "project_master_charters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"goal" text NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"declared_by" uuid NOT NULL,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN "read_when" jsonb;--> statement-breakpoint
ALTER TABLE "project_master_charters" ADD CONSTRAINT "project_master_charters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_master_charters" ADD CONSTRAINT "project_master_charters_declared_by_users_id_fk" FOREIGN KEY ("declared_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_master_charters_project_version_uq" ON "project_master_charters" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX "project_master_charters_project_version_idx" ON "project_master_charters" USING btree ("project_id","version");--> statement-breakpoint
CREATE OR REPLACE FUNCTION master_charter_rules_ok(rules jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(rules) = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(rules) AS elem
      WHERE jsonb_typeof(elem) <> 'string' OR btrim(elem #>> '{}') = ''
    );
$$;--> statement-breakpoint
ALTER TABLE "project_master_charters" ADD CONSTRAINT "master_charter_goal_not_blank_chk" CHECK (btrim("goal") <> '');--> statement-breakpoint
ALTER TABLE "project_master_charters" ADD CONSTRAINT "master_charter_rules_shape_chk" CHECK (master_charter_rules_ok("rules"));--> statement-breakpoint
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
            'open', 'confirmed', 'clarified', 'waiting', 'approved', 'in_progress', 'developed',
            'testing', 'tested', 'awaiting_release', 'releasing', 'closed', 'reopen', 'on_hold',
            'needs_info', 'draft', 'dropped'
          )
        )
      )
    )
  );
$$;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_read_when_chk" CHECK (knowledge_read_when_ok("read_when"));