-- ISS-802 — pinned/behind split: a project skill can be marked pinned
-- (intentional, permanent divergence from its template). Pinned skills are
-- excluded from behindTemplate/drift computation everywhere it runs
-- (effective.ts, forge-skills.ts, template-propagation.ts).

ALTER TABLE "skills" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "pinned_reason" text;
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "pinned_by" text;
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "pinned_at" timestamp with time zone;
