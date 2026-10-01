-- A land on a deployed branch records a contract version (ISS-20, slice E2 of the ecosystem design).
-- contract_versions, created empty by 0323 for this slice, now holds the whole contract-version-v1
-- document of each version, the classification its diff measured, the artifact it was measured from
-- and the contract elements that artifact names. contract_artifacts holds each artifact once by its
-- sha256, so the next land is diffed against bytes core hashed itself. contract_measurements is the
-- ledger of every land core observed on a branch an environment deploys from, one row per contract
-- and commit, pending until it settles as recorded, unchanged, stale or refused, so a land that was
-- not measured says so and why. No writer has existed for contract_versions; a row there cannot
-- carry the document this schema requires, so the migration stops and names it rather than invent
-- one. Rollback is dropping the two new tables and the five new columns.
DO $$
DECLARE stray record;
BEGIN
  SELECT provider_project_id, contract_slug, version INTO stray FROM contract_versions LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'contract_versions holds % / % version % with no contract-version document; E2 records versions from measured artifacts and cannot invent one for it', stray.provider_project_id, stray.contract_slug, stray.version;
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "contract_artifacts" (
	"sha256" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"byte_length" integer NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_artifacts_sha256_chk" CHECK ("contract_artifacts"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "contract_measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_project_id" uuid NOT NULL,
	"contract_slug" text NOT NULL,
	"commit_sha" text NOT NULL,
	"branch" text NOT NULL,
	"environments" text[] NOT NULL,
	"outcome" text NOT NULL,
	"version" text,
	"reason" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "contract_measurements_outcome_chk" CHECK ("contract_measurements"."outcome" IN ('pending', 'recorded', 'unchanged', 'stale', 'refused')),
	CONSTRAINT "contract_measurements_commit_chk" CHECK ("contract_measurements"."commit_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "contract_measurements_settled_chk" CHECK (("contract_measurements"."outcome" = 'pending') = ("contract_measurements"."settled_at" IS NULL)),
	CONSTRAINT "contract_measurements_reason_chk" CHECK ("contract_measurements"."outcome" NOT IN ('refused', 'stale') OR "contract_measurements"."reason" IS NOT NULL),
	CONSTRAINT "contract_measurements_version_chk" CHECK (("contract_measurements"."outcome" = 'recorded') = ("contract_measurements"."version" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "contract_versions" ADD COLUMN "contract_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD COLUMN "document" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD COLUMN "classification" text NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD COLUMN "artifact_sha256" text;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD COLUMN "elements" text[];--> statement-breakpoint
ALTER TABLE "contract_measurements" ADD CONSTRAINT "contract_measurements_provider_project_id_projects_id_fk" FOREIGN KEY ("provider_project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_measurements_land_uq" ON "contract_measurements" USING btree ("provider_project_id","contract_slug","commit_sha");--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_artifact_sha256_contract_artifacts_sha256_fk" FOREIGN KEY ("artifact_sha256") REFERENCES "public"."contract_artifacts"("sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_versions_latest_idx" ON "contract_versions" USING btree ("provider_project_id","contract_slug","recorded_at");--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_classification_chk" CHECK ("contract_versions"."classification" IN ('breaking', 'non-breaking', 'unknown', 'initial'));
