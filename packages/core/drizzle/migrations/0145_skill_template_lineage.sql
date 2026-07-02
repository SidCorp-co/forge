-- ISS-605: template-propagation protocol, step 1 — lineage stamp.
-- Records which global template a project skill copy was adopted from and at
-- which template version. Plain uuid (no FK): deleting a template must not
-- cascade into project copies.
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "based_on_global_skill_id" uuid;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "based_on_global_version" integer;

-- Best-effort backfill: link existing project copies to the same-name global
-- template. The adopted VERSION is unknowable historically — left NULL, which
-- the drift sweep deliberately treats as behind-template.
UPDATE "skills" p
SET "based_on_global_skill_id" = g.id
FROM "skills" g
WHERE p.scope = 'project'
  AND g.scope = 'global'
  AND g.name = p.name
  AND p."based_on_global_skill_id" IS NULL;
