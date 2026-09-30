-- A binding may hold role `source`: the storefront a project's changes are made in (project-config
-- design, binding-v1). Like a `service` binding it serves no stage. Bindings also gain a revision
-- that every UPDATE bumps, so a binding-document write can carry the revision it was read at and be
-- refused STALE_BASE whichever door moved the row since. Existing rows keep their role and start at
-- revision 1; rollback is restoring the two checks without `source` once no such row exists.
ALTER TABLE "integration_bindings" DROP CONSTRAINT "integration_bindings_role_chk";--> statement-breakpoint
ALTER TABLE "integration_bindings" DROP CONSTRAINT "integration_bindings_role_stages_chk";--> statement-breakpoint
ALTER TABLE "integration_bindings" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_bindings" ADD CONSTRAINT "integration_bindings_role_chk" CHECK (role IN ('deploy', 'service', 'source'));--> statement-breakpoint
ALTER TABLE "integration_bindings" ADD CONSTRAINT "integration_bindings_role_stages_chk" CHECK ((role IN ('service', 'source') AND cardinality(stages) = 0) OR (role = 'deploy' AND array_ndims(stages) = 1 AND cardinality(stages) BETWEEN 1 AND 2 AND stages <@ ARRAY['preview', 'live'] AND (cardinality(stages) = 1 OR stages[1] <> stages[2])));--> statement-breakpoint
CREATE OR REPLACE FUNCTION integration_bindings_bump_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER integration_bindings_bump_revision_trg BEFORE UPDATE ON "integration_bindings" FOR EACH ROW EXECUTE FUNCTION integration_bindings_bump_revision();
