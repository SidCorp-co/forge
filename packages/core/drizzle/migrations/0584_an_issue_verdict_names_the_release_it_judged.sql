-- An issue criterion verdict can name the release it was judged on (ISS-900, FB-479), as a
-- requirement's verdict can since 0583. On a project whose owner rules out commit fields (agenfold's
-- `release-is-the-agents-record`) production reports only a version and declares no source probe, so
-- an issue verdict naming a commit was never placed under what is live and never counted; a runtime is
-- held to 40-64 hex, which a version is not. A `release` verdict names the version instead, checked by
-- the door against the releases the project recorded as shipped.
--
-- No row is rewritten: no stored row is of kind `release`, and every other kind keeps its own branch
-- of the identity CHECK unchanged. ROLLBACK: delete any `release` row (or abort naming them), drop
-- `criterion_verdicts_release_chk` and the column, and restore the 0360 identity CHECK.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD COLUMN IF NOT EXISTS "release_version" text;--> statement-breakpoint
ALTER TABLE "criterion_verdicts" DROP CONSTRAINT IF EXISTS "criterion_verdicts_release_chk";--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_release_chk" CHECK (("criterion_verdicts"."identity_kind" = 'release' AND coalesce("criterion_verdicts"."release_version", '') ~ '^[0-9]{1,9}\.[0-9]{1,9}\.[0-9]{1,9}(-[a-z][a-z0-9]{0,15}\.[0-9]{1,9})?$')
        OR ("criterion_verdicts"."identity_kind" IS DISTINCT FROM 'release' AND "criterion_verdicts"."release_version" IS NULL));--> statement-breakpoint
ALTER TABLE "criterion_verdicts" DROP CONSTRAINT IF EXISTS "criterion_verdicts_identity_chk";--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_identity_chk" CHECK (("criterion_verdicts"."identity_kind" IS NULL AND "criterion_verdicts"."commit_sha" IS NULL AND "criterion_verdicts"."runtime_ref" IS NULL AND "criterion_verdicts"."design_workflow_id" IS NULL AND "criterion_verdicts"."design_revision" IS NULL AND "criterion_verdicts"."contract_ref" IS NULL AND "criterion_verdicts"."contract_version" IS NULL)
        OR ("criterion_verdicts"."identity_kind" = 'commit' AND "criterion_verdicts"."commit_sha" ~ '^[0-9a-f]{40}$' AND "criterion_verdicts"."runtime_ref" IS NULL AND "criterion_verdicts"."design_workflow_id" IS NULL AND "criterion_verdicts"."design_revision" IS NULL AND "criterion_verdicts"."contract_ref" IS NULL AND "criterion_verdicts"."contract_version" IS NULL)
        OR ("criterion_verdicts"."identity_kind" = 'commit_unresolved' AND "criterion_verdicts"."backfilled" AND "criterion_verdicts"."commit_sha" ~ '^[0-9a-f]{7,39}$' AND "criterion_verdicts"."runtime_ref" IS NULL AND "criterion_verdicts"."design_workflow_id" IS NULL AND "criterion_verdicts"."design_revision" IS NULL AND "criterion_verdicts"."contract_ref" IS NULL AND "criterion_verdicts"."contract_version" IS NULL)
        OR ("criterion_verdicts"."identity_kind" = 'runtime' AND "criterion_verdicts"."runtime_ref" ~ '^[0-9a-f]{40,64}$' AND "criterion_verdicts"."commit_sha" IS NULL AND "criterion_verdicts"."design_workflow_id" IS NULL AND "criterion_verdicts"."design_revision" IS NULL AND "criterion_verdicts"."contract_ref" IS NULL AND "criterion_verdicts"."contract_version" IS NULL)
        OR ("criterion_verdicts"."identity_kind" = 'design' AND "criterion_verdicts"."design_workflow_id" IS NOT NULL AND "criterion_verdicts"."design_revision" >= 1 AND "criterion_verdicts"."commit_sha" IS NULL AND "criterion_verdicts"."runtime_ref" IS NULL AND "criterion_verdicts"."contract_ref" IS NULL AND "criterion_verdicts"."contract_version" IS NULL)
        OR ("criterion_verdicts"."identity_kind" = 'contract' AND "criterion_verdicts"."contract_ref" ~ '[^[:space:]]' AND "criterion_verdicts"."contract_version" ~ '[^[:space:]]' AND "criterion_verdicts"."commit_sha" IS NULL AND "criterion_verdicts"."runtime_ref" IS NULL AND "criterion_verdicts"."design_workflow_id" IS NULL AND "criterion_verdicts"."design_revision" IS NULL)
        OR ("criterion_verdicts"."identity_kind" = 'storefront_draft' AND "criterion_verdicts"."commit_sha" IS NULL AND "criterion_verdicts"."runtime_ref" IS NULL AND "criterion_verdicts"."design_workflow_id" IS NULL AND "criterion_verdicts"."design_revision" IS NULL AND "criterion_verdicts"."contract_ref" IS NULL AND "criterion_verdicts"."contract_version" IS NULL)
        OR ("criterion_verdicts"."identity_kind" = 'release' AND "criterion_verdicts"."commit_sha" IS NULL AND "criterion_verdicts"."runtime_ref" IS NULL AND "criterion_verdicts"."design_workflow_id" IS NULL AND "criterion_verdicts"."design_revision" IS NULL AND "criterion_verdicts"."contract_ref" IS NULL AND "criterion_verdicts"."contract_version" IS NULL));
