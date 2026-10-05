-- requirement-to-delivery `triage`: a contract change routed to an issue carries the end of the
-- provider's commitment window as data on the wait it writes, never only as a sentence. A wait's
-- deadline is written once, like its contract and version.
-- requirement-lifecycle `start` (E2): a contract request from another project lands as a draft
-- requirement that names the requesting project and the contract; only this project agrees it.
--
-- ROLLBACK: ALTER TABLE "issue_contract_waits" DROP COLUMN "due_at"; ALTER TABLE "requirements"
-- DROP COLUMN "requested_by_project_id", DROP COLUMN "requested_contract_slug"; re-run 0407's
-- function. Deadlines and request provenance are lost; nothing else reads them.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "issue_contract_waits" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "requested_by_project_id" uuid REFERENCES "projects"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN "requested_contract_slug" text;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_request_chk" CHECK ("requested_contract_slug" IS NULL OR ("requested_by_project_id" IS NOT NULL AND length("requested_contract_slug") BETWEEN 1 AND 120));--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_request_self_chk" CHECK ("requested_by_project_id" IS DISTINCT FROM "project_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION issue_contract_wait_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM issues i WHERE i.id = NEW.issue_id AND i.project_id = NEW.project_id) THEN
      RAISE EXCEPTION 'CONTRACT_WAIT_PROJECT_MISMATCH: issue % is not in project %', NEW.issue_id, NEW.project_id;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.issue_id IS DISTINCT FROM OLD.issue_id
     OR NEW.provider_project_id IS DISTINCT FROM OLD.provider_project_id
     OR NEW.contract_slug IS DISTINCT FROM OLD.contract_slug OR NEW.min_version IS DISTINCT FROM OLD.min_version
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    RAISE EXCEPTION 'CONTRACT_WAIT_IMMUTABLE: wait % names its issue, contract, version and deadline once', OLD.id;
  END IF;
  IF OLD.settled_at IS NOT NULL AND (NEW.settled_at IS DISTINCT FROM OLD.settled_at OR NEW.settled_version IS DISTINCT FROM OLD.settled_version) THEN
    RAISE EXCEPTION 'CONTRACT_WAIT_SETTLED_ONCE: wait % was settled by % and stays settled', OLD.id, OLD.settled_version;
  END IF;
  IF OLD.retracted_at IS NOT NULL AND (NEW.retracted_at IS DISTINCT FROM OLD.retracted_at OR NEW.retract_reason IS DISTINCT FROM OLD.retract_reason OR NEW.retracted_by IS DISTINCT FROM OLD.retracted_by) THEN
    RAISE EXCEPTION 'CONTRACT_WAIT_RETRACTED: wait % was retracted and stays as it was', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
