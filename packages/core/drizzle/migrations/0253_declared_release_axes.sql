-- ISS-1046 — one column that answered three questions becomes three declared axes.
--
-- `integration_bindings.environment` ('staging' | 'prod') was read as all of:
-- what a binding is FOR, which environments a deploy binding serves, and whether
-- a project has a release at all. Seven of eight providers carried 'prod' as a
-- filler the column demanded and nothing meant, and the release gate inferred
-- from branch names plus that filler — which could not see a storefront, and
-- left eight pixelight issues at `released` with no way forward.
--
-- After this migration:
--   integration_bindings.role    'deploy' | 'service'      — what it is for
--   integration_bindings.stages  {} | {preview} | {live} | {preview,live}
--   projects.release_model       'none' | 'promote' | 'publish'
--   projects.release_strategy    set iff 'promote'
--   projects.live_branch         renamed from production_branch, read iff 'promote'
--
-- DECLARED, NEVER DERIVED. Every value below is transcribed from the fleet
-- measured on 2026-09-16 (36 projects, 36 bindings), not computed from the row.
--
-- ARCHIVED ROWS ARE ROWS. The first measurement read the 32 projects the API
-- returns by default, which excludes the archived; the coverage assertion below
-- reads `projects` with no such filter, because `release_model` is about to be
-- NOT NULL on every row in the table. The four archived projects and the two
-- bindings one of them still carries are therefore declared here too, and the
-- measurement now reads `/api/projects?archived=true`. Caught before the deploy
-- by the assertion itself, which is what it is for; a filter added to the
-- assertion instead would have left four rows taking `DEFAULT 'none'` in silence,
-- and that default is the filler this migration exists to delete.
-- A project or a binding this file does not name ABORTS the migration by name
-- rather than being defaulted: a default here would be the same inference the
-- change exists to remove, and it would arrive silently. The way out of such an
-- abort is to add the named row to the VALUES list and redeploy — never to widen
-- a fallback.
--
-- TWO ROWS ARE EXEMPT, AND ONLY BECAUSE THEY CARRY NO JUDGEMENT. Section 4 below
-- forces a value where the vocabulary leaves exactly one, and announces each row
-- it touches by NOTICE: a binding whose provider has no deploy adapter can only be
-- `service`, and a project created inside the deploy window carrying no
-- deploy-capable binding can only be `none`. Everything else still aborts. The
-- reason those two exist at all is measured rather than supposed: two google
-- bindings appeared four minutes apart while this file was being prepared, so a
-- transcription is never complete at boot and the strict rule alone would make an
-- unattended deploy a race it can lose.
--
-- BEHAVIOUR-PRESERVING at the gate. The four projects gated today (anhome,
-- portal-lighthuman, sid-desk, sidpeak) get `promote` and stay gated; every
-- other project keeps closing its own issues. The three storefronts get
-- `publish` — that IS a change, and it is the defect the issue names: their
-- release is an act on a live binding and no branch test could ever see it.
--
-- NON-DESTRUCTIVE. `production_branch` is RENAMED, not nulled: six projects
-- carry a real value there (adminhub-api/adminhub-ui `release/production`,
-- epodsystem-core/sidcorp-mail `master`, house-supabase/sidboss `main`) and a
-- value under a non-`promote` model is UNREAD rather than misread. Running
-- backwards is 0253_down.sql, which reads the same declared table.
--
-- cm:guard the journal `when` for this entry is max(when) + 86400000 and NEVER a
-- real timestamp. `src/db/migrate.ts` reads the single highest `created_at`
-- already applied and skips every lower entry SILENTLY and forever, so a real
-- timestamp lands below entries already in the target database and the container
-- serves new code against an old schema (ISS-807).

-- === 1. the new columns, nullable for now =================================
ALTER TABLE "projects" ADD COLUMN "release_model" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "release_strategy" text;--> statement-breakpoint
ALTER TABLE "projects" RENAME COLUMN "production_branch" TO "live_branch";--> statement-breakpoint
ALTER TABLE "integration_bindings" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "integration_bindings" ADD COLUMN "stages" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint

-- === 2. the declared project table ========================================
-- A real table, not a TEMP one: `ON COMMIT DROP` only survives while one
-- transaction spans the whole file, and whether that holds is the migrator's
-- business rather than this file's. Dropped explicitly at the end; a failed run
-- leaves it behind on purpose, where the operator fixing the abort can read it.
DROP TABLE IF EXISTS iss1046_projects;--> statement-breakpoint
CREATE TABLE iss1046_projects (
  project_id uuid PRIMARY KEY,
  slug text NOT NULL,
  release_model text NOT NULL,
  release_strategy text
);--> statement-breakpoint

INSERT INTO iss1046_projects (project_id, slug, release_model, release_strategy) VALUES
  ('8075eba2-c7d3-464e-b4a9-38f45d3dd1ab', 'adminhub-api', 'none', NULL),
  ('c5b8ca60-4c61-4d63-bbc8-1092b5013b82', 'adminhub-ui', 'none', NULL),
  ('36a0dce3-8469-41df-995b-197f28af9127', 'apiflow', 'none', NULL),
  ('9ad9b562-840a-473b-9114-b6243d61deff', 'archmap', 'none', NULL),
  ('213c5a3a-ab32-447e-b653-ad7203cc9613', 'brand-gateway', 'none', NULL),
  ('f68d7fe1-de30-45f8-9791-2e397dcdb2be', 'butlocs', 'publish', NULL),
  ('afb748ed-d31e-46ee-92c3-91c467c2afc0', 'ceo-dashboard', 'none', NULL),
  ('c043de63-35a1-424c-b783-2c8052257abe', 'codemap', 'none', NULL),
  ('3a954d77-7c65-4119-9d7c-1113592324c8', 'devbox', 'none', NULL),
  ('2d8a76db-8803-4078-a49b-d946d814d2f8', 'epod-cli', 'none', NULL),
  ('68567cd4-f517-43a8-b616-6f73d7ed2e00', 'epodsystem-core', 'none', NULL),
  ('e4fc92b3-e524-496d-abc1-98c2510e7dc4', 'erp', 'none', NULL),
  ('34bfcc10-cea2-4e73-bc51-5bb4d4067182', 'finance-automation', 'none', NULL),
  ('da368b0a-8e21-4763-9d90-8f7b9d0c7115', 'forge-dev', 'none', NULL),
  ('cda0adf0-fa3e-436c-ad7e-f3357e62778a', 'forge-plugin', 'none', NULL),
  ('326cccd2-ce95-4999-836c-8c5bb6a46bc3', 'getcontent', 'none', NULL),
  ('9f6cd30a-c93a-43de-b171-56e5ef716388', 'home-kieutrung-services-anhome', 'promote', 'merge-branch'),
  ('b32651af-49e1-47e2-8723-03cf7023dd8b', 'house-supabase', 'none', NULL),
  ('efb0748d-d534-49d1-bacf-d64879695b99', 'kinetrak', 'none', NULL),
  ('8668d187-739d-430f-92cf-a3dd35b13399', 'mailpilot', 'none', NULL),
  ('ae1e9833-b795-4c45-bdbb-6d6e09830bba', 'mowment', 'publish', NULL),
  ('eb7d116b-e637-4775-9c48-5aae5fb0519d', 'pixelight', 'publish', NULL),
  ('47a3d15e-6264-4348-8c71-01e83d132fcd', 'portal-lighthuman', 'promote', 'merge-branch'),
  ('fa83289d-1cb4-4915-b03c-947247ff2088', 'proxy', 'none', NULL),
  ('77e0fd20-f88f-419d-ad36-f2801e481cc5', 'server-vault', 'none', NULL),
  ('2126d65a-d732-483b-a0ff-eb74fd88c53f', 'sid-desk', 'promote', 'merge-branch'),
  ('87b28e29-2a67-4358-9278-a2f6435a06aa', 'sid-growth', 'none', NULL),
  ('7b445de4-c41f-4914-8810-de97ba47a4c0', 'sidboss', 'none', NULL),
  ('125f3b8d-614c-44c4-af59-eabd2583c712', 'sidcorp-mail', 'none', NULL),
  ('c1e40b9b-7e8d-43e9-ac54-380c7e966abc', 'sidpeak', 'promote', 'merge-branch'),
  ('a3c78a5b-4751-4a57-b829-c42c276eea49', 'traceos', 'none', NULL),
  ('1f02624a-e3f7-422e-92b1-ec256fd7002a', 'trai-heo', 'none', NULL),
  -- The four archived projects. `none` is a declaration rather than a default: archiving IS the
  -- owner's act saying this project ships nothing more, and it is the only model that needs no
  -- live target and reads no branch — so dodgeprint-api keeps `release/stg` in `live_branch`,
  -- unread rather than misread, exactly as the six live projects below `promote` do.
  ('7dca1ad6-ab90-443f-a188-98f3e770265b', 'dodgeprint-api', 'none', NULL),
  ('dc99f7e0-498b-4eed-8397-2c18c1e624ab', 'dodgeprint-fe', 'none', NULL),
  ('fc06ff89-3235-4f6b-a9c0-f8c519cf3913', 'dodgeprint-ui-v2', 'none', NULL),
  ('e8660972-6283-4104-8dba-6aee4983840a', 'forge-redesign', 'none', NULL),
  -- The twelve this migration could not see when its list was written: QA fixtures, an
  -- issue's control row, throwaways and demo boards. They existed in `projects` and were
  -- absent from the VALUES list, so the assertion below fired on every container boot and
  -- held the deploy for 36 minutes on 2026-09-17. `none` here is the owner's declaration,
  -- given while that deploy was down, and not a default this migration chose: each ships
  -- nothing, reads no branch and needs no live target.
  -- The lesson is the list's, not the assertion's: a roster measured when a migration is
  -- written is not the roster it meets when it runs.
  ('cac01f47-6292-469e-9e71-5da20dabe217', 'client-work-tracker', 'none', NULL),
  ('7e7e3f09-a0ab-459a-a74c-ce4447f7963e', 'iss-1422-control', 'none', NULL),
  ('9e1dd801-af72-4459-bee9-d14904d3eda1', 'iss-702-throwaway', 'none', NULL),
  ('f1b91354-d701-4dca-8161-c3df83207492', 'lego-guide', 'none', NULL),
  ('0a47ec80-8659-432b-9180-4c58ec95911d', 'linh-design-studio', 'none', NULL),
  ('c7caf56b-6128-4bab-9270-192611f2fe83', 'linh-studio-q3-projects', 'none', NULL),
  ('4473d199-d965-415d-b5ba-021a4f03a7f1', 'linh-studio-web', 'none', NULL),
  ('2b3872c5-9ea3-464d-9773-9339629f7e97', 'qa-iss319-create-verify', 'none', NULL),
  ('f9601fc8-9152-4d19-9dd2-6810c4fe8539', 'qa-project-available-for-testing', 'none', NULL),
  ('3fee0966-58b3-4ee4-84ad-8c6d7aef7fdc', 'sid-hrm-v2', 'none', NULL),
  ('0149a933-4034-411f-bbe4-f614b9ea6280', 'studio-brand-refresh', 'none', NULL),
  ('fdc2748b-cd42-491b-a56c-c077f51da68b', 'summer-client-projects', 'none', NULL);--> statement-breakpoint

-- === 3. the declared binding table ========================================
-- `old_environment` is carried so 0253_down.sql restores the exact value rather
-- than deriving one. The forward map is NOT injective — three epodsystem 'prod'
-- rows become {preview,live} while three others become `service`, and
-- getcontent's coolify 'staging' becomes {live} — so an inverse computed from
-- role and stages would put the wrong value back on six rows.
DROP TABLE IF EXISTS iss1046_bindings;--> statement-breakpoint
CREATE TABLE iss1046_bindings (
  binding_id uuid PRIMARY KEY,
  slug text NOT NULL,
  provider text NOT NULL,
  old_environment text NOT NULL,
  role text NOT NULL,
  stages text[] NOT NULL
);--> statement-breakpoint

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
  ('e1767a04-228d-469a-b239-18112cfd678c', 'traceos', 'github', 'prod', 'service', '{}'::text[]),
  -- dodgeprint-api is archived and still carries the two bindings below. `service` for both
  -- is the reading every other sentry and rocketchat binding in this list gets, and it is the
  -- only one representable: neither provider has a deploy adapter, so `deploy` names a thing
  -- Forge cannot do. The sentry row is the one this issue's description cites as the evidence —
  -- the release channel that was an error tracker. It keeps its `environment` for the way back.
  ('4866a074-e511-4543-b778-ce55b12e9227', 'dodgeprint-api', 'sentry', 'prod', 'service', '{}'::text[]),
  ('4e11a87b-e739-4a26-8fc0-cd1a33dab313', 'dodgeprint-api', 'rocketchat', 'prod', 'service', '{}'::text[]),
  -- The six the binding roster could not see either, for the same reason the project
  -- roster missed twelve: both lists were transcribed from one measurement, and the
  -- fleet kept moving afterwards. All six belong to the two QA throwaways, which this
  -- migration declares `release_model = 'none'`.
  --
  -- They are declared `deploy` rather than `service` on purpose. `integration_bindings_service_uq`
  -- admits one SERVICE binding per (project, provider, label), and qa-project-available-for-testing
  -- carries THREE epodsystem rows plus two coolify rows; declaring them service would
  -- stake the deploy on labels this list cannot read. `deploy` is exempt from that index,
  -- and it is also what the rows are: coolify staging/prod is `preview`/`live` in all
  -- twenty-five fleet precedents, and epodsystem prod is `{preview,live}` wherever it
  -- deploys (butlocs, mowment, pixelight).
  ('749993a9-132a-4268-a724-8c67340b88d0', 'qa-project-available-for-testing', 'coolify', 'staging', 'deploy', ARRAY['preview']::text[]),
  ('924679c1-43c5-4783-92fa-4f0653a76ff3', 'qa-iss319-create-verify', 'coolify', 'staging', 'deploy', ARRAY['preview']::text[]),
  ('efc97d7e-6f61-4a3f-9264-f0318091a454', 'qa-project-available-for-testing', 'coolify', 'prod', 'deploy', ARRAY['live']::text[]),
  ('a6782c32-8ef7-42c9-905b-d055023edfc8', 'qa-project-available-for-testing', 'epodsystem', 'prod', 'deploy', ARRAY['preview', 'live']::text[]),
  ('aac45791-3758-4178-b992-129f312df2c2', 'qa-project-available-for-testing', 'epodsystem', 'prod', 'deploy', ARRAY['preview', 'live']::text[]),
  ('e5544f43-d94f-4bb6-984e-c9f4d4954640', 'qa-project-available-for-testing', 'epodsystem', 'prod', 'deploy', ARRAY['preview', 'live']::text[]);--> statement-breakpoint

-- === 4. coverage, BEFORE anything is dropped ==============================
--
-- 4·0. THE ROWS WHOSE ROLE IS FORCED RATHER THAN CHOSEN.
--
-- The fleet is written to while this migration is being prepared: two google bindings appeared
-- four minutes apart on 2026-09-16 between one measurement and the next. A transcription can
-- never be complete at boot, so the list alone would make an unattended deploy a race, and a
-- lost race aborts the container's boot.
--
-- But not every unmapped row is ambiguous. `role: 'deploy'` is refused by the server for a
-- provider with no deploy adapter (`contracts/deploy-capability.ts`, `integrations/binding-shape.ts`,
-- `integrations/connection-routes.ts`), so for sentry, rocketchat, github, google and postman
-- `service` is the ONLY value the row may legally hold. That is forced by the vocabulary, not
-- guessed from what is commonest — the property this migration refuses to take is a JUDGEMENT,
-- and there is no judgement here to take.
--
-- A deploy-capable provider is a different row: coolify's 'staging' meant `{preview}` on seven
-- projects and `{live}` on getcontent, and only its owner knows which. Those still abort by name
-- below, which is why this block names the providers it covers rather than the ones it does not.
--
-- Each row taken this way is announced by NOTICE in the deploy log. A rule applied in silence is
-- the same defect as a default applied in silence.
DO $$
DECLARE forced text; n int;
BEGIN
  SELECT string_agg(format('%s (project %s, provider %s, environment %s)', b.id, p.slug, b.provider, b.environment), ', ' ORDER BY b.id), count(*)
    INTO forced, n
    FROM integration_bindings b
    JOIN projects p ON p.id = b.project_id
    LEFT JOIN iss1046_bindings d ON d.binding_id = b.id
   WHERE d.binding_id IS NULL
     AND b.provider NOT IN ('coolify', 'epodsystem', 'agent');
  IF forced IS NOT NULL THEN
    RAISE NOTICE 'ISS-1046: % binding(s) created after the fleet was measured take role=service by '
      'force rather than by declaration, because their provider has no deploy adapter and the '
      'server refuses role=deploy on it: %', n, forced;
  END IF;
END $$;--> statement-breakpoint

INSERT INTO iss1046_bindings (binding_id, slug, provider, old_environment, role, stages)
SELECT b.id, p.slug, b.provider, b.environment, 'service', '{}'::text[]
  FROM integration_bindings b
  JOIN projects p ON p.id = b.project_id
  LEFT JOIN iss1046_bindings d ON d.binding_id = b.id
 WHERE d.binding_id IS NULL
   AND b.provider NOT IN ('coolify', 'epodsystem', 'agent');--> statement-breakpoint

-- 4·1. AND THE SAME, ONE AXIS UP, FOR A PROJECT CREATED INSIDE THE DEPLOY WINDOW.
--
-- Narrower than the binding rule, because `release_model` IS the judgement this migration exists
-- to collect. Two conditions together, and both are required:
--
--   * created AFTER the measurement below — so every project that existed when a person read the
--     fleet is declared by name, and only the window between that reading and this boot is
--     covered; and
--   * carrying no binding at all on a provider Forge can deploy to — so it cannot be a project
--     whose release anybody is relying on. The old gate could fire on a NON-deploy binding, which
--     is the defect in this issue's own description, but it could not fire on no binding at all.
--
-- A project matching both had no release under the retired model and gets none under the declared
-- one: `none` here is the same value every project created one minute after this migration takes
-- from the column's own DEFAULT. A project created in the window that DOES carry a deploy binding
-- is a judgement nobody made, and still aborts by name below.
DO $$
DECLARE forced text; n int;
BEGIN
  SELECT string_agg(format('%s (%s, created %s)', p.id, p.slug, p.created_at), ', ' ORDER BY p.slug), count(*)
    INTO forced, n
    FROM projects p
    LEFT JOIN iss1046_projects d ON d.project_id = p.id
   WHERE d.project_id IS NULL
     AND p.created_at > TIMESTAMPTZ '2026-09-16 17:26:00+00'
     AND NOT EXISTS (
       SELECT 1 FROM integration_bindings b
        WHERE b.project_id = p.id AND b.provider IN ('coolify', 'epodsystem', 'agent'));
  IF forced IS NOT NULL THEN
    RAISE NOTICE 'ISS-1046: % project(s) created after the fleet was measured and carrying no '
      'deploy-capable binding take release_model=none by force rather than by declaration: %', n, forced;
  END IF;
END $$;--> statement-breakpoint

INSERT INTO iss1046_projects (project_id, slug, release_model, release_strategy)
SELECT p.id, p.slug, 'none', NULL
  FROM projects p
  LEFT JOIN iss1046_projects d ON d.project_id = p.id
 WHERE d.project_id IS NULL
   AND p.created_at > TIMESTAMPTZ '2026-09-16 17:26:00+00'
   AND NOT EXISTS (
     SELECT 1 FROM integration_bindings b
      WHERE b.project_id = p.id AND b.provider IN ('coolify', 'epodsystem', 'agent'));--> statement-breakpoint

-- Two assertions, not one: the binding table cannot see a project that has no
-- bindings, so 18 of the 36 projects are invisible to it.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(format('%s (%s)', p.id, p.slug), ', ' ORDER BY p.slug)
    INTO missing
    FROM projects p
    LEFT JOIN iss1046_projects d ON d.project_id = p.id
   WHERE d.project_id IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1046: % project(s) carry no declared release_model: %. '
      'This migration declares a value per project and derives none. Add each '
      'project above to the VALUES list in 0253 with the release model its owner '
      'intends (none | promote | publish) and redeploy. Do NOT default them.',
      (SELECT count(*) FROM projects p LEFT JOIN iss1046_projects d ON d.project_id = p.id WHERE d.project_id IS NULL),
      missing;
  END IF;
END $$;--> statement-breakpoint

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(format('%s (project %s, provider %s, environment %s)', b.id, b.project_id, b.provider, b.environment), ', ' ORDER BY b.id)
    INTO missing
    FROM integration_bindings b
    LEFT JOIN iss1046_bindings d ON d.binding_id = b.id
   WHERE d.binding_id IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1046: % binding(s) carry no declared role/stages: %. '
      'A binding created after the fleet was measured cannot be mapped by rule — '
      '`environment` meant three different things and only its owner knows which. '
      'Add each binding above to the VALUES list in 0253 and redeploy.',
      (SELECT count(*) FROM integration_bindings b LEFT JOIN iss1046_bindings d ON d.binding_id = b.id WHERE d.binding_id IS NULL),
      missing;
  END IF;
END $$;--> statement-breakpoint

-- === 4b. the declaration is checked against the columns the database holds ===
--
-- The coverage checks above ask "is every row declared". They cannot ask "is each row
-- declared as ITSELF" — the VALUES lists were transcribed by hand from a measurement of
-- the live fleet, and a line pasted against the wrong binding id would backfill a role
-- and stages belonging to another row, then have 0253_down.sql restore that other row's
-- environment. Nothing downstream could tell.
--
-- `provider`, `environment` and the project `slug` are carried in the lists for exactly
-- this: the database already holds all three, so they are an INDEPENDENT reading of the
-- same rows rather than a second copy of the same claim. A mismatch aborts naming both
-- sides, and is never reconciled by trusting one of them.
DO $$
DECLARE wrong text;
BEGIN
  SELECT string_agg(
           format('%s (declared %s/%s/%s, actual %s/%s/%s)',
                  b.id, d.slug, d.provider, d.old_environment, p.slug, b.provider, b.environment),
           ', ' ORDER BY b.id)
    INTO wrong
    FROM iss1046_bindings d
    JOIN integration_bindings b ON b.id = d.binding_id
    JOIN projects p ON p.id = b.project_id
   WHERE d.provider IS DISTINCT FROM b.provider
      OR d.old_environment IS DISTINCT FROM b.environment
      OR d.slug IS DISTINCT FROM p.slug;
  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1046: the declared binding list disagrees with the database about %. '
      'Each entry names the binding id, its project slug, its provider and its `environment` '
      'as measured; these do not match the row that id actually points at, so the list was '
      'transcribed against the wrong row and would backfill another binding''s role. '
      'Correct the VALUES list in 0253 against a fresh measurement — never adjust the row.',
      wrong;
  END IF;
END $$;--> statement-breakpoint

DO $$
DECLARE wrong text;
BEGIN
  SELECT string_agg(format('%s (declared %s, actual %s)', d.project_id, d.slug, p.slug), ', '
                    ORDER BY d.project_id)
    INTO wrong
    FROM iss1046_projects d
    JOIN projects p ON p.id = d.project_id
   WHERE d.slug IS DISTINCT FROM p.slug;
  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1046: the declared project list disagrees with the database about %. '
      'The slug carried beside each project id is the measurement''s own reading of that row; '
      'a mismatch means a release model was transcribed against the wrong project. '
      'Correct the VALUES list in 0253 against a fresh measurement.',
      wrong;
  END IF;
END $$;--> statement-breakpoint

-- === 5. the backfill ======================================================
UPDATE projects p
   SET release_model = d.release_model,
       release_strategy = d.release_strategy
  FROM iss1046_projects d
 WHERE d.project_id = p.id;--> statement-breakpoint

UPDATE integration_bindings b
   SET role = d.role,
       stages = d.stages
  FROM iss1046_bindings d
 WHERE d.binding_id = b.id;--> statement-breakpoint

-- A `promote` project with no live branch cannot satisfy projects_live_branch_chk.
-- Catch it here, where the message can name the projects, rather than at ADD CONSTRAINT.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s (%s)', id, slug), ', ' ORDER BY slug) INTO bad
    FROM projects WHERE release_model = 'promote' AND live_branch IS NULL;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1046: project(s) declared `promote` with no live_branch: %. '
      '`promote` means the release moves code from base_branch to live_branch, so '
      'a live branch is required. Either set one, or declare `publish` (the release '
      'is an act on a live binding, no ref moves) or `none`.', bad;
  END IF;
END $$;--> statement-breakpoint

-- === 6. lock the shape ====================================================
ALTER TABLE "projects" ALTER COLUMN "release_model" SET DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "release_model" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_bindings" ALTER COLUMN "role" SET NOT NULL;--> statement-breakpoint

-- === 6b. the service rows `environment` was keeping apart =================
--
-- `integration_bindings_service_uq` admits one service row per (project, provider,
-- label). Until now `environment` was doing that separating work, and dropping it in
-- step 7 collides every pair that differed only there — a row the new schema cannot
-- represent, which is refused rather than deleted.
--
-- It is not refused outright, because ISS-558 already gave these rows a home: `label`
-- is '' for the default binding and a kebab slug for a named extra one. A staging
-- postman binding beside a prod one IS a named extra binding; moving it there keeps
-- the row, keeps it reachable, and leaves the default where every lookup expects it.
-- `prod` keeps '' because that is what the default has always meant here.
--
-- Derived when this runs, never transcribed. The two hand-written rosters above each
-- missed rows created after they were measured; a rule that reads the database at
-- migration time cannot.
DO $$
DECLARE moved text;
BEGIN
  WITH dup AS (
    SELECT b.id, b.environment
      FROM integration_bindings b
      JOIN integration_bindings o
        ON o.project_id = b.project_id AND o.provider = b.provider
       AND o.label = b.label AND o.id <> b.id AND o.role = 'service'
     WHERE b.role = 'service' AND b.label = '' AND b.environment <> 'prod'
  ), upd AS (
    UPDATE integration_bindings b SET label = dup.environment
      FROM dup WHERE b.id = dup.id
    RETURNING b.id, b.project_id, b.provider, b.label
  )
  SELECT string_agg(format('%s (project %s, provider %s) -> label %L',
                           u.id, p.slug, u.provider, u.label), ', ' ORDER BY u.id)
    INTO moved
    FROM upd u JOIN projects p ON p.id = u.project_id;
  IF moved IS NOT NULL THEN
    RAISE NOTICE 'ISS-1046: service binding(s) kept their row by taking a label, because '
      '`environment` was the only thing separating them from the default binding and this '
      'migration retires it: %', moved;
  END IF;
END $$;--> statement-breakpoint

-- Whatever the rule above could not separate, the index would refuse as a bare 23505
-- naming one key and no row. Every other assertion in this file names its rows; this
-- one owes the same.
DO $$
DECLARE clash text;
BEGIN
  SELECT string_agg(format('%s/%s/%L x%s', g.slug, g.provider, g.label, g.n), ', '
                    ORDER BY g.slug, g.provider, g.label)
    INTO clash
    FROM (SELECT p.slug, b.provider, b.label, count(*) AS n
            FROM integration_bindings b
            JOIN projects p ON p.id = b.project_id
           WHERE b.role = 'service'
           GROUP BY p.slug, b.provider, b.label
          HAVING count(*) > 1) g;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1046: service bindings still share (project, provider, label) after '
      'labelling: %. A provider with no deploy adapter can only be `service`, so these rows '
      'cannot both be the default binding and cannot be declared apart. Give one of each pair '
      'a distinct `label`, or retire it — never delete it to make the index build.', clash;
  END IF;
END $$;--> statement-breakpoint

-- === 7. retire the column and its index ===================================
DROP INDEX IF EXISTS "integration_bindings_project_provider_env_label_uq";--> statement-breakpoint
ALTER TABLE "integration_bindings" DROP COLUMN "environment";--> statement-breakpoint

-- One active SERVICE binding per (project, provider, label). A DEPLOY binding is
-- deliberately NOT covered: a stage may hold more than one and core never picks
-- among them, and eight fleet projects already carry two coolify bindings apiece.
CREATE UNIQUE INDEX "integration_bindings_service_uq"
    ON "integration_bindings" ("project_id","provider","label")
 WHERE role = 'service';--> statement-breakpoint

-- === 8. the rules, in the database ========================================
ALTER TABLE "projects" ADD CONSTRAINT "projects_release_model_chk"
  CHECK (release_model IN ('none','promote','publish'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_live_branch_chk"
  CHECK (release_model <> 'promote' OR live_branch IS NOT NULL);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_release_strategy_chk"
  CHECK ((release_model = 'promote') = (release_strategy IS NOT NULL)
         AND (release_strategy IS NULL OR release_strategy IN ('merge-branch','cherry-pick','tag-mr')));--> statement-breakpoint
ALTER TABLE "integration_bindings" ADD CONSTRAINT "integration_bindings_role_chk"
  CHECK (role IN ('deploy','service'));--> statement-breakpoint
-- cardinality(), NEVER array_length(): array_length('{}',1) is NULL, so a CHECK
-- written that way evaluates NULL on the empty array and PASSES the very row it
-- exists to refuse.
--
-- `stages` is a SET, and the four ways it can fail to be one are all refused here rather
-- than normalised: a duplicate member (`{live,live}`), a third member, a nested array
-- (`array_ndims`), and a member outside the vocabulary. `<@` alone admits the first three,
-- because containment asks only that every element belong to the set.
ALTER TABLE "integration_bindings" ADD CONSTRAINT "integration_bindings_role_stages_chk"
  CHECK ((role = 'service' AND cardinality(stages) = 0)
      OR (role = 'deploy' AND array_ndims(stages) = 1
          AND cardinality(stages) BETWEEN 1 AND 2
          AND stages <@ ARRAY['preview','live']
          AND (cardinality(stages) = 1 OR stages[1] <> stages[2])));--> statement-breakpoint

-- === 9. the declared tables have done their job ===========================
DROP TABLE iss1046_bindings;--> statement-breakpoint
DROP TABLE iss1046_projects;
