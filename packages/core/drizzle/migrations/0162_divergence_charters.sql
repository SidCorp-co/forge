-- ISS-800 (Update Pipeline §5) — Divergence Charter: per-project machine-readable
-- record of intentional deviations from the default pipeline template.
-- ONE row per project; `entries` is a jsonb array of owner-authored statements
-- (each: difference/reason/incidentRefs/revertable). Consumed by the Master
-- agent as item 7 in its 12-item bundle (ISS-795 §4). Charter mutations emit
-- `charter.changed` into `skill_activity_events` (ISS-797) in the same tx.

CREATE TABLE "divergence_charters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "divergence_charters_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "divergence_charters" ADD CONSTRAINT "divergence_charters_project_id_projects_id_fk"
	FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "divergence_charters_project_uq" ON "divergence_charters" USING btree ("project_id");
--> statement-breakpoint

-- Seed the anhome project charter (ISS-795 §5 / ISS-800 seed requirement).
-- NO-OP when the project does not exist (e.g. fresh dev installs).
DO $$
BEGIN
  INSERT INTO divergence_charters (project_id, entries, created_at, updated_at)
  SELECT
    p.id,
    '[
      {
        "id": "forge-release-no-prod-merge",
        "skill": "forge-release",
        "difference": "Production merge removed from the release stage. forge-release does NOT merge to productionBranch.",
        "reason": "Commit 148484a0 put 65 conflict-marker lines on production and broke the build for 10 days (ISS-354, ISS-365). The merge was removed permanently after that incident.",
        "incidentRefs": ["ISS-354", "ISS-365", "148484a0"],
        "revertable": false
      },
      {
        "id": "forge-release-batched-cutoff",
        "skill": "forge-release",
        "difference": "Release uses a batched cutoff model, not per-issue merges.",
        "reason": "Batched cutoff was adopted alongside the no-prod-merge decision to prevent partial-state deploys between issues that share infrastructure dependencies.",
        "incidentRefs": ["ISS-354", "ISS-365"],
        "revertable": false
      }
    ]'::jsonb,
    now(),
    now()
  FROM projects p
  WHERE p.slug = 'anhome'
  ON CONFLICT (project_id) DO NOTHING;
END $$;
