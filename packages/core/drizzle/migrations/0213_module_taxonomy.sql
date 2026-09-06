-- ISS-593 — the module taxonomy, additive in every statement.
--
-- `labels` becomes the module table: `kind` separates a module from a plain label,
-- `parent_id` gives modules a hierarchy, `description` is theirs to carry.
-- `issue_labels.is_primary` is the single source of truth for an issue's primary module.
--
-- Classification: ADDITIVE. Every existing `labels` row reads back as kind='label' with a
-- NULL parent and description; every existing `issue_labels` row reads back is_primary=false;
-- code that predates this migration selects neither column and keeps working. Running it
-- backwards discards nothing that existed before it.
--
-- The one statement that can fail on live data is the partial unique index, and it cannot:
-- nothing can have written is_primary=true before the column existed.
ALTER TABLE "issue_labels" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "kind" text DEFAULT 'label' NOT NULL;--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_parent_id_labels_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."labels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_labels_primary_uq" ON "issue_labels" USING btree ("issue_id") WHERE is_primary = true;--> statement-breakpoint
CREATE INDEX "labels_parent_id_idx" ON "labels" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_kind_chk" CHECK ("labels"."kind" IN ('label', 'module'));
