-- The project document's `source.git.defaultBranch` is where work is cut from and lands; the webhook
-- secret is the project secret `secret://project/webhook-secret`; no route ever read the API key.
-- Values are not migrated (design D8): the secrets are re-entered through the write-only secrets
-- route, and `scripts/export-legacy-project-config.mjs` prints what the columns still hold.
--
-- A branch is not dropped where the document would not carry it: a project whose column names a
-- branch its document does not declare as `source.git.defaultBranch` aborts the deploy, naming it.
-- A document whose `source.type` is not `git` (`none`, `storefront`) has no git for a branch to belong
-- to, and passes.

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(
           format('%s (%s): base_branch %L, document defaultBranch %L',
                  p.slug, p.id, p.base_branch, d.document #>> '{source,git,defaultBranch}'),
           '; ' ORDER BY p.slug)
    INTO bad
    FROM projects p
    LEFT JOIN project_config_documents d ON d.project_id = p.id
   WHERE p.base_branch IS NOT NULL
     AND coalesce(d.document #>> '{source,type}', 'git') = 'git'
     AND (d.document #>> '{source,git,defaultBranch}') IS DISTINCT FROM p.base_branch;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'projects.base_branch cannot be dropped: % — write the branch as source.git.defaultBranch with PUT /api/projects/:id/config, then deploy again', bad;
  END IF;
END $$;--> statement-breakpoint
DROP INDEX "projects_api_key_uq";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "base_branch";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "webhook_secret";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "api_key";
