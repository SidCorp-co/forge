-- Skills scope, explicit single path (see docs/skills-scope-playbook.md).
-- Only project-scoped skills are usable; globals are templates that must be
-- adopted (cloned) before use. This backfill makes existing data obey that
-- rule WITHOUT breaking any project that relied on the old global-fallback:
-- every stage registration ends up pointing at a project skill.
--
-- Idempotent: step 1 is guarded by NOT EXISTS (same-name project skill); step 2
-- only matches registrations that still point at a global (none remain after a
-- successful run).

-- Step 1 — clone each registered global that has no same-name project skill in
-- that project into a new project-scoped copy (identical body → identical hash).
INSERT INTO skills (
  name, description, scope, project_id, prompt, tools, manifest,
  source, version, content_hash, skill_md, target, files, local_guide
)
SELECT DISTINCT
  s.name, s.description, 'project', sr.project_id, s.prompt, s.tools, s.manifest,
  'user', 1, s.content_hash, s.skill_md, s.target, s.files, s.local_guide
FROM skill_registrations sr
JOIN skills s ON s.id = sr.skill_id
WHERE s.scope = 'global'
  AND NOT EXISTS (
    SELECT 1 FROM skills p
    WHERE p.scope = 'project'
      AND p.project_id = sr.project_id
      AND p.name = s.name
  );

-- Step 2 — repoint every registration that still points at a global to the
-- same-name project skill (created above, or a pre-existing shadow).
UPDATE skill_registrations sr
SET skill_id = p.id
FROM skills g, skills p
WHERE sr.skill_id = g.id
  AND g.scope = 'global'
  AND p.scope = 'project'
  AND p.project_id = sr.project_id
  AND p.name = g.name;
