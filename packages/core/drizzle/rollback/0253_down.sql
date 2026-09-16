-- ISS-1046 — the way back from 0253_declared_release_axes.sql.
--
-- NOT run by `db/migrate.js`. This file is applied BY HAND, against the database,
-- BEFORE the previous image is started — never after. The previous image's boot
-- migrator knows only its own migrations, so starting it against the new schema
-- makes it loop; and the runtime image installs only openssh-keygen, openssh-client
-- and git, so there is no `psql` inside it. Reach the database from a one-off
-- container on the app's own network:
--
--   docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' <core-container>
--   docker run --rm --network <that-network> -i postgres:16 \
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     < packages/core/drizzle/rollback/0253_down.sql
--
-- The file is REDIRECTED INTO the container's stdin. `-f 0253_down.sql` would make psql
-- look for the file INSIDE the disposable container, which has no checkout mounted, so
-- recovery would stop before executing a single statement.
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<0253 hash>';
--
-- Then start the previous image.
--
-- `environment` is RESTORED FROM THE DECLARED TABLE, never derived from role and
-- stages. The forward map is not injective: three epodsystem 'prod' rows became
-- {preview,live} while three others became `service`, and getcontent's coolify
-- 'staging' became {live}. An inverse computed from the new columns would put the
-- wrong value back on six rows and nothing would report it.
--
-- `live_branch` is renamed back. 0253 nulled nothing, so nothing is unrecoverable.

BEGIN;

DROP TABLE IF EXISTS iss1046_bindings;
CREATE TABLE iss1046_bindings (
  binding_id uuid PRIMARY KEY,
  slug text NOT NULL,
  provider text NOT NULL,
  old_environment text NOT NULL,
  role text NOT NULL,
  stages text[] NOT NULL
);

INSERT INTO iss1046_bindings (binding_id, slug, provider, old_environment, role, stages) VALUES
  ('4682e858-9e8f-40e9-b871-370da5df6ab7', 'archmap', 'coolify', 'staging', 'deploy', ARRAY['preview']::text[]),
  ('6a02620f-9f55-4d5c-af7d-b35f516c7737', 'brand-gateway', 'coolify', 'prod', 'deploy', ARRAY['live']::text[]),
  ('f128b741-b737-42f0-a459-f8a01b82df7f', 'brand-gateway', 'coolify', 'staging', 'deploy', ARRAY['preview']::text[]),
  ('a9824701-5ae6-4775-bfc9-6f540469a141', 'butlocs', 'epodsystem', 'prod', 'deploy', ARRAY['preview', 'live']::text[]),
  ('e14e7f08-b63f-4a14-bb6a-aca73e11b912', 'ceo-dashboard', 'coolify', 'prod', 'deploy', ARRAY['live']::text[]),
  ('ba598921-52c7-4f3d-ab0f-7563948c877e', 'ceo-dashboard', 'coolify', 'staging', 'deploy', ARRAY['preview']::text[]),
  ('2fe97870-e27b-423e-b148-20345ab824a9', 'codemap', 'github', 'prod', 'service', '{}'::text[]),
  ('139a2328-a51c-42b1-98f3-d3f9fc1905e4', 'epod-cli', 'github', 'prod', 'service', '{}'::text[]),
  ('79b2cd7f-cc40-435c-a32c-af07d848235f', 'finance-automation', 'coolify', 'staging', 'deploy', ARRAY['preview']::text[]),
  ('e55621e5-c8f5-4fd6-95f5-a1aa79a07c48', 'finance-automation', 'coolify', 'prod', 'deploy', ARRAY['live']::text[]),
  ('e8a3b125-c557-460b-84ea-8e3f025277b1', 'forge-dev', 'coolify', 'prod', 'deploy', ARRAY['live']::text[]),
  ('6e4d888a-98bd-4b41-ac0d-c6c2dde8fb62', 'forge-dev', 'github', 'prod', 'service', '{}'::text[]),
  ('5614ca0b-e17f-4c26-a0d4-5f753b4b2df4', 'forge-dev', 'rocketchat', 'prod', 'service', '{}'::text[]),
  ('218d20ff-cdcc-432e-91db-7d688412a56d', 'forge-dev', 'sentry', 'prod', 'service', '{}'::text[]),
  ('e609b385-0c19-4e70-b2b8-cbe4ddf8d46c', 'forge-dev', 'epodsystem', 'prod', 'service', '{}'::text[]),
  ('83ad5102-0b73-43f8-af58-b4372c8cea99', 'forge-dev', 'coolify', 'staging', 'deploy', ARRAY['preview']::text[]),
  ('93ecfb6a-4e6f-496e-a4d9-7387faae9e8f', 'getcontent', 'epodsystem', 'prod', 'service', '{}'::text[]),
  ('f860d091-ed8c-4af2-8fa1-97aa8be54df7', 'getcontent', 'rocketchat', 'prod', 'service', '{}'::text[]),
  ('fef02132-4203-4e85-8c68-3edd9bff219c', 'getcontent', 'coolify', 'staging', 'deploy', ARRAY['live']::text[]),
  ('5b656778-ddc6-4ff6-816e-4d32b3483809', 'home-kieutrung-services-anhome', 'epodsystem', 'prod', 'service', '{}'::text[]),
  ('2b5bb75a-3da7-4bbb-b23e-29115b71a5e1', 'home-kieutrung-services-anhome', 'sentry', 'prod', 'service', '{}'::text[]),
  ('c947843b-8d2c-4e07-b31b-39a721f446ef', 'home-kieutrung-services-anhome', 'coolify', 'prod', 'deploy', ARRAY['live']::text[]),
  ('e9213b0c-ec74-4dd6-9327-f4dd8c9d2526', 'home-kieutrung-services-anhome', 'coolify', 'staging', 'deploy', ARRAY['preview']::text[]),
  ('0da68d7d-56a0-4c3f-8f4a-cde0234fe9ff', 'mowment', 'epodsystem', 'prod', 'deploy', ARRAY['preview', 'live']::text[]),
  ('d2869d0a-023f-4d4b-905c-a76fe0cf157d', 'pixelight', 'epodsystem', 'prod', 'deploy', ARRAY['preview', 'live']::text[]),
  ('3e0aeb99-1ffd-41e6-bf5b-5637ccd3635e', 'portal-lighthuman', 'coolify', 'prod', 'deploy', ARRAY['live']::text[]),
  ('cacf4417-4838-49eb-ab97-9016c1c3b1cb', 'portal-lighthuman', 'coolify', 'staging', 'deploy', ARRAY['preview']::text[]),
  ('82a6e1f5-0f52-4f59-920a-fac41f2c2463', 'sid-desk', 'sentry', 'prod', 'service', '{}'::text[]),
  ('60bdbda1-732f-4ffa-a0b4-4d16bd815b13', 'sid-desk', 'coolify', 'prod', 'deploy', ARRAY['live']::text[]),
  ('86ecd42c-bf0f-4813-ac4c-247a5d41c394', 'sid-desk', 'coolify', 'staging', 'deploy', ARRAY['preview']::text[]),
  ('faa50da2-df75-4331-84e3-13f00865b3ed', 'sidboss', 'coolify', 'staging', 'deploy', ARRAY['preview']::text[]),
  ('a14a8cdb-ee78-4b00-812a-9a4bb376168a', 'sidpeak', 'coolify', 'prod', 'deploy', ARRAY['live']::text[]),
  ('153efbf7-632b-430e-bef7-ca7bdc0a7757', 'sidpeak', 'coolify', 'staging', 'deploy', ARRAY['preview']::text[]),
  ('e1767a04-228d-469a-b239-18112cfd678c', 'traceos', 'github', 'prod', 'service', '{}'::text[]);

-- A binding created while 0253 was live has no declared `environment` to go back
-- to, and guessing one is how a rollback loses a row's meaning silently. Name it
-- and stop: decide its environment by hand, add it to the list above, re-run.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(format('%s (project %s, provider %s, role %s, stages %s)', b.id, b.project_id, b.provider, b.role, b.stages), ', ' ORDER BY b.id)
    INTO missing
    FROM integration_bindings b
    LEFT JOIN iss1046_bindings d ON d.binding_id = b.id
   WHERE d.binding_id IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1046 rollback: % binding(s) created after 0253 have no declared environment to restore: %. '
      'role+stages do not determine it — the forward map is not injective. Decide each one by hand, '
      'append it to the VALUES list in this file, and re-run.',
      (SELECT count(*) FROM integration_bindings b LEFT JOIN iss1046_bindings d ON d.binding_id = b.id WHERE d.binding_id IS NULL),
      missing;
  END IF;
END $$;

ALTER TABLE "integration_bindings" DROP CONSTRAINT IF EXISTS "integration_bindings_role_stages_chk";
ALTER TABLE "integration_bindings" DROP CONSTRAINT IF EXISTS "integration_bindings_role_chk";
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_release_strategy_chk";
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_live_branch_chk";
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_release_model_chk";
DROP INDEX IF EXISTS "integration_bindings_service_uq";

ALTER TABLE "integration_bindings" ADD COLUMN "environment" text;

UPDATE integration_bindings b
   SET environment = d.old_environment
  FROM iss1046_bindings d
 WHERE d.binding_id = b.id;

ALTER TABLE "integration_bindings" ALTER COLUMN "environment" SET NOT NULL;

CREATE UNIQUE INDEX "integration_bindings_project_provider_env_label_uq"
    ON "integration_bindings" ("project_id","provider","environment","label");

ALTER TABLE "integration_bindings" DROP COLUMN "stages";
ALTER TABLE "integration_bindings" DROP COLUMN "role";

ALTER TABLE "projects" RENAME COLUMN "live_branch" TO "production_branch";
ALTER TABLE "projects" DROP COLUMN "release_strategy";
ALTER TABLE "projects" DROP COLUMN "release_model";

DROP TABLE iss1046_bindings;

COMMIT;
