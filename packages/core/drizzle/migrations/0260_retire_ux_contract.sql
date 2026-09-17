CREATE TABLE "ux_contract_retirement_backup" (
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"injection" text NOT NULL,
	"migrated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ux_contract_retirement_backup_pk" PRIMARY KEY("project_id","slug")
);
--> statement-breakpoint
CREATE TABLE "ux_contract_retirement_backup_schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"template_key" text NOT NULL,
	"cron" text,
	"mode" text,
	"enabled" boolean NOT NULL,
	"migrated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- ISS-1068 — the UX Contract subsystem is retired, and each project keeps the prose a person wrote.
--
-- The prose is NOT written here. ISS-1048's 0254 already moved every project's compiled contract
-- into `knowledge_entries` at slug `ux-contract`, so this migration's job is to PROVE that the
-- rows it is about to destroy are represented there, and to refuse by name when they are not.
--
-- Existence of the entry is deliberately not the proof. A stale or independently edited body would
-- pass an existence check while the rules being dropped went unrepresented, which is the silent
-- substitution CLAUDE.md forbids. So the check is per rule: every ACTIVE `ux_contract_rules` row's
-- text has to appear verbatim inside its own project's entry body. That is a pure-SQL check only
-- because `compileUxContract` emitted each rule as its own `- <text>` bullet — the compiler is
-- deleted in this same change, and this containment test is what survives it.
--
-- Measured on forge-beta 2026-09-17 before this was written: 2 projects hold rules (forge-dev 22,
-- qa-project-available-for-testing 22), both hold a live entry, and 44 of 44 active rules appear
-- verbatim in their project's body. The abort branches below therefore fire on no deployment we
-- know of; they exist so that one whose rows differ stops rather than loses the prose.
--
-- A RAISE anywhere below rolls the whole file back, so nothing is dropped on a deployment that
-- fails any check.
DO $iss1068$
DECLARE
  proj RECORD;
  bad_rule RECORD;
  live_schedule RECORD;
  entry_body TEXT;
  removed_schedules INT;
BEGIN
  -- Back up the delivery settings of every surviving entry BEFORE any of them is changed, so the
  -- one thing this migration overwrites is restorable with a single UPDATE ... FROM.
  INSERT INTO ux_contract_retirement_backup (project_id, slug, kind, injection)
  SELECT ke.project_id, ke.slug, ke.kind, ke.injection
    FROM knowledge_entries ke
   WHERE ke.slug = 'ux-contract'
     AND ke.archived_at IS NULL
  ON CONFLICT (project_id, slug) DO UPDATE SET
    kind = EXCLUDED.kind,
    injection = EXCLUDED.injection,
    migrated_at = now();

  -- Preservation, per project and then per rule.
  FOR proj IN
    SELECT DISTINCT p.id AS id, p.slug AS slug
      FROM projects p
      JOIN ux_contract_rules r ON r.project_id = p.id
     ORDER BY p.slug
  LOOP
    entry_body := NULL;
    SELECT ke.body INTO entry_body
      FROM knowledge_entries ke
     WHERE ke.project_id = proj.id
       AND ke.slug = 'ux-contract'
       AND ke.archived_at IS NULL;

    IF entry_body IS NULL THEN
      RAISE EXCEPTION
        'ISS-1068: project % (%) holds ux_contract_rules rows but no live knowledge entry at slug ''ux-contract'', so dropping the table would destroy prose that exists nowhere else. Nothing was dropped. Write that project''s contract to PUT /api/projects/%/knowledge/ux-contract first, then deploy again.',
        proj.slug, proj.id, proj.id;
    END IF;

    FOR bad_rule IN
      SELECT r.id AS id, r.text AS text
        FROM ux_contract_rules r
       WHERE r.project_id = proj.id
         AND r.status = 'active'
         AND position(r.text IN entry_body) = 0
       ORDER BY r.order_index
    LOOP
      RAISE EXCEPTION
        'ISS-1068: project % (%) holds an ACTIVE ux_contract_rules row (%) whose text does not appear in its ''ux-contract'' knowledge entry, so that rule''s prose is not preserved and dropping the table would lose it. Nothing was dropped. The unrepresented rule reads: %',
        proj.slug, proj.id, bad_rule.id, bad_rule.text;
    END LOOP;
  END LOOP;

  -- Refuse a schedule somebody is relying on; there is no template left to migrate it to.
  FOR live_schedule IN
    SELECT s.id AS id, s.project_id AS project_id, COALESCE(p.slug, '<no project>') AS slug
      FROM schedules s
      LEFT JOIN projects p ON p.id = s.project_id
     WHERE s.template_key = 'ux-contract-improve'
       AND s.enabled
     ORDER BY s.id
  LOOP
    RAISE EXCEPTION
      'ISS-1068: schedule % on project % is ENABLED and points at template key ''ux-contract-improve'', which this migration removes. A live schedule is not resolved against a template that no longer exists. Nothing was dropped. Disable or delete that schedule, then deploy again.',
      live_schedule.id, live_schedule.slug;
  END LOOP;

  -- Everything below this line changes rows. Every check that could refuse has already run.

  -- The prose stays exactly as written; only its delivery moves. `guide` becomes `rule` because
  -- that is what the text is, and `always` becomes `on_demand` because the always-applied block is
  -- the subsystem's live effect and is the thing being retired.
  UPDATE knowledge_entries
     SET kind = 'rule',
         injection = 'on_demand',
         updated_at = now()
   WHERE slug = 'ux-contract'
     AND archived_at IS NULL
     AND (kind <> 'rule' OR injection <> 'on_demand');

  INSERT INTO ux_contract_retirement_backup_schedules (id, project_id, template_key, cron, mode, enabled)
  SELECT s.id, s.project_id, s.template_key, s.cron, s.mode, s.enabled
    FROM schedules s
   WHERE s.template_key = 'ux-contract-improve'
  ON CONFLICT (id) DO NOTHING;

  DELETE FROM schedules WHERE template_key = 'ux-contract-improve';
  GET DIAGNOSTICS removed_schedules = ROW_COUNT;
  RAISE NOTICE 'ISS-1068: removed % disabled ux-contract-improve schedule(s), backed up verbatim in ux_contract_retirement_backup_schedules', removed_schedules;
END
$iss1068$;
--> statement-breakpoint
UPDATE projects
   SET agent_config = agent_config - 'uxContractProfile'
 WHERE agent_config ? 'uxContractProfile';
--> statement-breakpoint
-- Not CASCADE. Nothing points at either table — measured 2026-09-17, all six foreign keys point
-- outward — so RESTRICT is free here, and if that ever stops being true the deploy stops and names
-- the dependent object instead of dropping it silently. `ux_findings` goes first because it is the
-- side holding the foreign key.
DROP TABLE "ux_findings";--> statement-breakpoint
DROP TABLE "ux_contract_rules";
