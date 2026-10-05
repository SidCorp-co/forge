-- REQ-9 (E1, E4), owner ruling 2026-10-05: an issue waits on `contract >= version`, never on an
-- issue in another project, and is dispatched once an approved version settles it. The provider may
-- be the issue's own project, where the contract is written before the build (contract-first).
-- 0394 dropped the earlier shape of this table; this one is created empty.
--
-- ROLLBACK: DROP TABLE "issue_contract_waits"; DROP FUNCTION issue_contract_wait_guard(); every
-- waiting issue becomes dispatchable again.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE "issue_contract_waits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE cascade,
	"provider_project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"contract_slug" text NOT NULL,
	"min_version" text NOT NULL,
	"reason" text,
	"created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_version" text,
	"settled_at" timestamp with time zone,
	"retracted_by" uuid REFERENCES "users"("id") ON DELETE restrict,
	"retracted_at" timestamp with time zone,
	"retract_reason" text,
	CONSTRAINT "issue_contract_waits_settled_version_fk" FOREIGN KEY ("provider_project_id", "contract_slug", "settled_version")
		REFERENCES "contract_versions"("provider_project_id", "contract_slug", "version") ON DELETE restrict,
	CONSTRAINT "issue_contract_waits_version_chk" CHECK (length("min_version") BETWEEN 1 AND 40),
	CONSTRAINT "issue_contract_waits_reason_chk" CHECK ("reason" IS NULL OR length("reason") BETWEEN 1 AND 1000),
	CONSTRAINT "issue_contract_waits_settled_chk" CHECK (("settled_version" IS NULL) = ("settled_at" IS NULL)),
	CONSTRAINT "issue_contract_waits_retracted_chk" CHECK (("retracted_at" IS NULL) = ("retracted_by" IS NULL) AND ("retracted_at" IS NULL) = ("retract_reason" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "issue_contract_waits_live_uq" ON "issue_contract_waits" ("issue_id", "provider_project_id", "contract_slug") WHERE retracted_at IS NULL;--> statement-breakpoint
CREATE INDEX "issue_contract_waits_issue_idx" ON "issue_contract_waits" ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_contract_waits_open_idx" ON "issue_contract_waits" ("provider_project_id", "contract_slug") WHERE retracted_at IS NULL AND settled_at IS NULL;--> statement-breakpoint

-- Kernel input: a row is born for its issue's own project, never re-aimed, and a settle or a retract
-- is written once. Anything else is refused by name rather than rewritten.
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
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'CONTRACT_WAIT_IMMUTABLE: wait % names its issue, contract and version once', OLD.id;
  END IF;
  IF OLD.settled_at IS NOT NULL AND (NEW.settled_at IS DISTINCT FROM OLD.settled_at OR NEW.settled_version IS DISTINCT FROM OLD.settled_version) THEN
    RAISE EXCEPTION 'CONTRACT_WAIT_SETTLED_ONCE: wait % was settled by % and stays settled', OLD.id, OLD.settled_version;
  END IF;
  IF OLD.retracted_at IS NOT NULL AND (NEW.retracted_at IS DISTINCT FROM OLD.retracted_at OR NEW.retract_reason IS DISTINCT FROM OLD.retract_reason OR NEW.retracted_by IS DISTINCT FROM OLD.retracted_by) THEN
    RAISE EXCEPTION 'CONTRACT_WAIT_RETRACTED: wait % was retracted and stays as it was', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "issue_contract_waits_guard_trg" BEFORE INSERT OR UPDATE ON "issue_contract_waits"
  FOR EACH ROW EXECUTE FUNCTION issue_contract_wait_guard();
