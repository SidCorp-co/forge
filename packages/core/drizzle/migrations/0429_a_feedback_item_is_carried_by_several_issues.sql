-- An issue route names one or more carriers (ISS-265). The one column `feedback.routed_issue_id` becomes
-- the table `feedback_route_issues`, one row per carrier, so an item delivered by several issues names
-- every one and its phase reads all of them. Every stored carrier is copied before the column goes, and
-- `feedback_route_chk` is rebuilt without it. A CHECK cannot read across tables, so a deferred
-- constraint trigger holds the pairing at commit: an item routed `issue` holds at least one carrier,
-- and an item routed otherwise, or not at all, holds none.
--
-- ROLLBACK: forward only. Folding the table back into one column keeps one carrier of each item and
--           loses the rest, so it is a migration of its own that names which carrier it keeps.

CREATE TABLE IF NOT EXISTS "feedback_route_issues" (
	"feedback_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	CONSTRAINT "feedback_route_issues_feedback_id_issue_id_pk" PRIMARY KEY("feedback_id","issue_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "feedback_route_issues" ADD CONSTRAINT "feedback_route_issues_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "feedback_route_issues" ADD CONSTRAINT "feedback_route_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_route_issues_issue_idx" ON "feedback_route_issues" USING btree ("issue_id");
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'feedback' AND column_name = 'routed_issue_id'
  ) THEN
    INSERT INTO "feedback_route_issues" ("feedback_id", "issue_id")
      SELECT "id", "routed_issue_id" FROM "feedback" WHERE "routed_issue_id" IS NOT NULL
      ON CONFLICT DO NOTHING;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_route_chk";
--> statement-breakpoint
DROP INDEX IF EXISTS "feedback_routed_issue_idx";
--> statement-breakpoint
ALTER TABLE "feedback" DROP COLUMN IF EXISTS "routed_issue_id";
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_route_chk" CHECK (("feedback"."route" IS NULL AND num_nonnulls("feedback"."routed_requirement_id", "feedback"."routed_suggestion_id", "feedback"."duplicate_of", "feedback"."answer") = 0)
        OR ("feedback"."route" = 'issue' AND num_nonnulls("feedback"."routed_requirement_id", "feedback"."routed_suggestion_id", "feedback"."duplicate_of", "feedback"."answer") = 0)
        OR ("feedback"."route" = 'revision' AND "feedback"."routed_suggestion_id" IS NOT NULL AND num_nonnulls("feedback"."routed_requirement_id", "feedback"."duplicate_of", "feedback"."answer") = 0)
        OR ("feedback"."route" = 'new_requirement' AND "feedback"."routed_requirement_id" IS NOT NULL AND num_nonnulls("feedback"."routed_suggestion_id", "feedback"."duplicate_of", "feedback"."answer") = 0)
        OR ("feedback"."route" = 'answer' AND "feedback"."answer" ~ '[^[:space:]]' AND num_nonnulls("feedback"."routed_requirement_id", "feedback"."routed_suggestion_id", "feedback"."duplicate_of") = 0)
        OR ("feedback"."route" = 'duplicate' AND "feedback"."duplicate_of" IS NOT NULL AND num_nonnulls("feedback"."routed_requirement_id", "feedback"."routed_suggestion_id", "feedback"."answer") = 0));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "feedback_route_carriers_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item uuid;
  item_route text;
  item_seq integer;
  carriers integer;
BEGIN
  IF TG_TABLE_NAME = 'feedback' THEN
    item := NEW."id";
  ELSIF TG_OP = 'DELETE' THEN
    item := OLD."feedback_id";
  ELSE
    item := NEW."feedback_id";
  END IF;
  SELECT "route", "fb_seq" INTO item_route, item_seq FROM "feedback" WHERE "id" = item;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO carriers FROM "feedback_route_issues" WHERE "feedback_id" = item;
  IF item_route = 'issue' AND carriers = 0 THEN
    RAISE EXCEPTION 'FEEDBACK_ROUTE_INCOMPLETE: FB-% is routed to an issue and names no issue that carries it', item_seq USING ERRCODE = 'check_violation';
  END IF;
  IF item_route IS DISTINCT FROM 'issue' AND carriers > 0 THEN
    RAISE EXCEPTION 'FEEDBACK_ROUTE_TARGET_MISMATCH: FB-% is routed %, not to an issue, yet % issue(s) carry it', item_seq, coalesce(item_route, 'nowhere'), carriers USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "feedback_route_carriers_guard" ON "feedback";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "feedback_route_carriers_guard" AFTER INSERT OR UPDATE OF "route" ON "feedback" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "feedback_route_carriers_guard"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "feedback_route_issues_carriers_guard" ON "feedback_route_issues";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "feedback_route_issues_carriers_guard" AFTER INSERT OR DELETE ON "feedback_route_issues" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "feedback_route_carriers_guard"();
