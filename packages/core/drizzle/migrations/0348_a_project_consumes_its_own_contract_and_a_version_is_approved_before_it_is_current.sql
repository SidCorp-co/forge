-- A project consumes its own contract, and a contract version is approved before it is current
-- (ISS-60 on dev).
--
-- An in-project link is a module of a project calling that project's own contract, and it names no
-- ecosystem; a cross-project link always names the one it was made in. The old check refused every
-- link to the same project, so contract-first inside one project could not be written at all.
ALTER TABLE "ecosystem_links" DROP CONSTRAINT "ecosystem_links_not_self_chk";--> statement-breakpoint
ALTER TABLE "ecosystem_links" ALTER COLUMN "ecosystem_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ecosystem_links" ADD CONSTRAINT "ecosystem_links_scope_chk" CHECK (("ecosystem_links"."consumer_project_id" <> "ecosystem_links"."provider_project_id") = ("ecosystem_links"."ecosystem_id" IS NOT NULL));--> statement-breakpoint

-- A recorded version is proposed; it is current only once approved, and a returned one says why.
ALTER TABLE "contract_versions" ADD COLUMN "approval" text DEFAULT 'proposed' NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD COLUMN "decided_by" uuid;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD COLUMN "decided_as" text;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD COLUMN "decision_reason" text;--> statement-breakpoint

-- Every version recorded before this gate existed was current the moment it was recorded, and links
-- already pin them. They are marked as decided before approval existed, by nobody, at the time they
-- were recorded, so no reader takes the backfill for a person's or an agent's decision.
UPDATE "contract_versions" SET "approval" = 'approved', "decided_as" = 'before-approval', "decided_at" = "recorded_at", "decision_reason" = 'recorded before contract versions were approved (migration 0348); current as recorded';--> statement-breakpoint

ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_approval_chk" CHECK ("contract_versions"."approval" IN ('proposed', 'approved', 'returned'));--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_decided_chk" CHECK (("contract_versions"."approval" = 'proposed') = ("contract_versions"."decided_at" IS NULL AND "contract_versions"."decided_as" IS NULL));--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_decided_as_chk" CHECK ("contract_versions"."decided_as" IS NULL OR ("contract_versions"."decided_as" IN ('person', 'agent') AND "contract_versions"."decided_by" IS NOT NULL) OR ("contract_versions"."decided_as" = 'before-approval' AND "contract_versions"."decided_by" IS NULL));--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_returned_chk" CHECK ("contract_versions"."approval" <> 'returned' OR ("contract_versions"."decision_reason" IS NOT NULL AND length("contract_versions"."decision_reason") BETWEEN 1 AND 2000));
