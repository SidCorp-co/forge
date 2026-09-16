CREATE TABLE "project_facts_migration_backup" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"project_facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"project_facts_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"migrated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_facts_migration_backup" ADD CONSTRAINT "project_facts_migration_backup_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- ISS-1048 — project prose leaves `projects.agent_config` for `knowledge_entries`.
--
-- Order inside this one transaction: back both maps up verbatim, verify a destination row for
-- every key, and only then strip the two jsonb keys. A RAISE anywhere below rolls the whole file
-- back, so the column is never stripped on a project whose keys did not all arrive.
--
-- The reserved list below is `RESERVED_PROJECT_FACT_KEYS` in
-- packages/core/src/projects/project-facts.ts, and `reserved-facts-parity.test.ts` holds the two
-- to each other. A reserved name in `projectFacts` was never readable — the resolver answers it
-- from a project column — so it is a key nobody can place, which is this migration's question
-- rather than its licence to delete.
DO $iss1048$
DECLARE
  proj RECORD;
  fact_key TEXT;
  fact_text TEXT;
  key_position INT;
  held INT;
  verified INT;
  existing_body TEXT;
  existing_archived TIMESTAMPTZ;
  reserved TEXT[] := ARRAY[
    'base-branch', 'live-branch', 'production-branch', 'repo-path',
    'test-urls', 'test-creds', 'test-notes', 'integrations'
  ];
BEGIN
  FOR proj IN
    SELECT
      p.id AS id,
      p.slug AS slug,
      COALESCE(p.agent_config -> 'projectFacts', '{}'::jsonb) AS facts,
      COALESCE(p.agent_config -> 'projectFactsConfig', '{}'::jsonb) AS facts_config
    FROM projects p
    WHERE p.agent_config ?| ARRAY['projectFacts', 'projectFactsConfig']
    ORDER BY p.id
  LOOP
    INSERT INTO project_facts_migration_backup (project_id, project_facts, project_facts_config)
    VALUES (proj.id, proj.facts, proj.facts_config)
    ON CONFLICT (project_id) DO UPDATE SET
      project_facts = EXCLUDED.project_facts,
      project_facts_config = EXCLUDED.project_facts_config,
      migrated_at = now();

    held := 0;
    verified := 0;
    key_position := 0;

    FOR fact_key, fact_text IN
      SELECT key, value FROM jsonb_each_text(proj.facts)
    LOOP
      held := held + 1;

      IF fact_key = ANY(reserved) THEN
        RAISE EXCEPTION
          'ISS-1048: project % (%) holds a projectFacts key named %, which is one of the reserved derived keys. A reserved key was never readable through projectFacts, so this migration cannot place it. Decide what that text is for, move it to a knowledge entry under a different slug or delete it, then run the migration again.',
          proj.slug, proj.id, fact_key;
      END IF;

      existing_body := NULL;
      existing_archived := NULL;
      SELECT ke.body, ke.archived_at
        INTO existing_body, existing_archived
        FROM knowledge_entries ke
       WHERE ke.project_id = proj.id AND ke.slug = fact_key;

      IF FOUND THEN
        IF existing_archived IS NOT NULL THEN
          RAISE EXCEPTION
            'ISS-1048: project % (%) already holds an ARCHIVED knowledge entry with slug %, and this migration will not resurrect one to make room for a projectFacts key of the same name. Restore or delete that entry, then run the migration again.',
            proj.slug, proj.id, fact_key;
        END IF;
        IF existing_body IS DISTINCT FROM fact_text THEN
          RAISE EXCEPTION
            'ISS-1048: project % (%) holds a knowledge entry with slug % whose body differs from the projectFacts text of the same name. Two texts under one name is not a question a migration can answer. Reconcile them, then run the migration again.',
            proj.slug, proj.id, fact_key;
        END IF;
      ELSE
        INSERT INTO knowledge_entries (
          project_id, kind, slug, title, body,
          injection, confidence, authored_by, order_index, metadata
        ) VALUES (
          proj.id,
          'guide',
          fact_key,
          fact_key,
          fact_text,
          CASE
            WHEN (proj.facts_config -> fact_key ->> 'alwaysInject') = 'true' THEN 'always'
            ELSE 'on_demand'
          END,
          'verified',
          'human',
          key_position,
          jsonb_build_object('migratedFrom', 'agentConfig.projectFacts')
        );
      END IF;

      key_position := key_position + 1;
    END LOOP;

    -- The count is re-read off the destination rather than taken from a counter this loop
    -- incremented: a counter would only ever restate what the loop above already did, and an
    -- assertion that cannot fail covers nothing. This one asks the table.
    SELECT count(*) INTO verified
      FROM knowledge_entries ke
     WHERE ke.project_id = proj.id
       AND ke.archived_at IS NULL
       AND ke.slug IN (SELECT key FROM jsonb_each_text(proj.facts));

    IF verified <> held THEN
      RAISE EXCEPTION
        'ISS-1048: project % (%) held % projectFacts key(s) and this migration verified % knowledge row(s) for it. The counts have to agree before the column is stripped, so nothing was stripped.',
        proj.slug, proj.id, held, verified;
    END IF;
  END LOOP;
END
$iss1048$;
--> statement-breakpoint
UPDATE projects
   SET agent_config = (agent_config - 'projectFacts') - 'projectFactsConfig'
 WHERE agent_config ?| ARRAY['projectFacts', 'projectFactsConfig'];
