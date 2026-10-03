ALTER TABLE "requirements" DROP CONSTRAINT "requirements_status_chk";--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_status_chk" CHECK ("requirements"."status" IN ('draft', 'agreed', 'accepted', 'dropped', 'deferred'));--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD COLUMN "accept_reason" text;--> statement-breakpoint
ALTER TABLE "requirement_baselines" ADD COLUMN "seq" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "requirement_baselines" ADD COLUMN "act" text DEFAULT 'agree' NOT NULL;--> statement-breakpoint
ALTER TABLE "requirement_baseline_pins" ADD COLUMN "baseline_seq" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "requirement_baseline_pins" DROP CONSTRAINT "requirement_baseline_pins_baseline_fk";--> statement-breakpoint
DROP INDEX "requirement_baseline_pins_baseline_idx";--> statement-breakpoint
ALTER TABLE "requirement_baselines" DROP CONSTRAINT "requirement_baselines_requirement_id_revision_pk";--> statement-breakpoint
ALTER TABLE "requirement_baselines" ADD CONSTRAINT "requirement_baselines_requirement_id_revision_seq_pk" PRIMARY KEY("requirement_id","revision","seq");--> statement-breakpoint
ALTER TABLE "requirement_baselines" ADD CONSTRAINT "requirement_baselines_seq_chk" CHECK ("requirement_baselines"."seq" >= 1);--> statement-breakpoint
ALTER TABLE "requirement_baselines" ADD CONSTRAINT "requirement_baselines_act_chk" CHECK ("requirement_baselines"."act" IN ('agree', 'repin') AND ("requirement_baselines"."act" = 'agree') = ("requirement_baselines"."seq" = 1));--> statement-breakpoint
ALTER TABLE "requirement_baseline_pins" ADD CONSTRAINT "requirement_baseline_pins_baseline_fk" FOREIGN KEY ("requirement_id","revision","baseline_seq") REFERENCES "public"."requirement_baselines"("requirement_id","revision","seq") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requirement_baseline_pins_baseline_idx" ON "requirement_baseline_pins" USING btree ("requirement_id","revision","baseline_seq");--> statement-breakpoint
CREATE TABLE "requirement_deferrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"act" text NOT NULL,
	"from_status" text NOT NULL,
	"target_phase" text,
	"reason" text,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_deferrals_act_chk" CHECK ("requirement_deferrals"."act" IN ('defer', 'undefer')),
	CONSTRAINT "requirement_deferrals_from_chk" CHECK (("requirement_deferrals"."act" = 'defer' AND "requirement_deferrals"."from_status" IN ('draft', 'agreed')) OR ("requirement_deferrals"."act" = 'undefer' AND "requirement_deferrals"."from_status" = 'deferred')),
	CONSTRAINT "requirement_deferrals_reason_chk" CHECK ("requirement_deferrals"."act" <> 'defer' OR "requirement_deferrals"."reason" ~ '[^[:space:]]'),
	CONSTRAINT "requirement_deferrals_phase_chk" CHECK ("requirement_deferrals"."act" = 'defer' OR "requirement_deferrals"."target_phase" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "requirement_deferrals" ADD CONSTRAINT "requirement_deferrals_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_deferrals" ADD CONSTRAINT "requirement_deferrals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requirement_deferrals_requirement_idx" ON "requirement_deferrals" USING btree ("requirement_id","decided_at");--> statement-breakpoint
CREATE FUNCTION "requirement_deferral_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "requirements" WHERE "id" = OLD."requirement_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'REQUIREMENT_DEFERRAL_IMMUTABLE: a defer or undefer of requirement % is insert-only; deciding again writes a new row', OLD."requirement_id" USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER "requirement_deferrals_guard" BEFORE UPDATE OR DELETE ON "requirement_deferrals" FOR EACH ROW EXECUTE FUNCTION "requirement_deferral_guard"();--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "planned_baseline_seq" integer;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "from_suggestion_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_from_suggestion_id_suggestions_id_fk" FOREIGN KEY ("from_suggestion_id") REFERENCES "public"."suggestions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "issues" SET "planned_baseline_seq" = 1 WHERE "planned_revision" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_planned_baseline_chk" CHECK ("issues"."planned_baseline_seq" IS NULL OR ("issues"."planned_revision" IS NOT NULL AND "issues"."planned_baseline_seq" >= 1));
