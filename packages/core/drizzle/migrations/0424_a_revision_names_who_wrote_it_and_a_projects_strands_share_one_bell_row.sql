-- A requirement revision records whether a person or an agent wrote it. An agent writes under the
-- account that paired its box, so author_id alone made a master's draft read "You · propose r1" to
-- the person who owns that account (F8). Existing rows take the kind of their author's account,
-- which is what the standing read used for them until now: nothing recorded which credential wrote
-- a row whose author is a person's account, so it stays human. The guard freezes the new column
-- with the rest of a revision's content once it leaves draft.
--
-- ROLLBACK: ALTER TABLE requirement_revisions DROP CONSTRAINT requirement_revisions_author_agency_chk;
--           ALTER TABLE requirement_revisions DROP COLUMN author_agency; and restore the guard from 0349.
--           The bell fold below is not undone: the folded rows carry every record the per-minute
--           rows did, and an old per-minute key would only found a new row again.

ALTER TABLE "requirement_revisions" ADD COLUMN "author_agency" text;
--> statement-breakpoint
UPDATE "requirement_revisions" rr
   SET "author_agency" = CASE u."kind" WHEN 'agent' THEN 'agent' ELSE 'human' END
  FROM "users" u
 WHERE u."id" = rr."author_id";
--> statement-breakpoint
ALTER TABLE "requirement_revisions" ALTER COLUMN "author_agency" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "requirement_revisions" ADD CONSTRAINT "requirement_revisions_author_agency_chk" CHECK ("requirement_revisions"."author_agency" IN ('human', 'agent'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "requirement_revision_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "requirements" WHERE "id" = OLD."requirement_id") THEN
      RAISE EXCEPTION 'REVISION_IMMUTABLE: requirement % revision % is evidence and is never deleted; only deleting its requirement removes it', OLD."requirement_id", OLD."revision" USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."requirement_id" <> OLD."requirement_id" OR NEW."revision" <> OLD."revision" THEN
    RAISE EXCEPTION 'REVISION_IMMUTABLE: requirement % revision % keeps its identity', OLD."requirement_id", OLD."revision" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."state" <> 'draft' AND (
       NEW."spec" IS DISTINCT FROM OLD."spec" OR NEW."spec_version" IS DISTINCT FROM OLD."spec_version"
    OR NEW."tldr" IS DISTINCT FROM OLD."tldr" OR NEW."change_summary" IS DISTINCT FROM OLD."change_summary"
    OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."base_revision" IS DISTINCT FROM OLD."base_revision"
    OR NEW."author_id" IS DISTINCT FROM OLD."author_id"
    OR NEW."author_agency" IS DISTINCT FROM OLD."author_agency") THEN
    RAISE EXCEPTION 'REVISION_IMMUTABLE: requirement % revision % is %, so its content is frozen; write a new revision', OLD."requirement_id", OLD."revision", OLD."state" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."state" <> OLD."state" AND (OLD."state", NEW."state") NOT IN (
       ('draft', 'proposed'), ('proposed', 'draft'), ('proposed', 'current'), ('current', 'superseded')) THEN
    RAISE EXCEPTION 'REVISION_STATE_TRANSITION: requirement % revision % cannot move % -> %; a revision moves draft, proposed, current, superseded', OLD."requirement_id", OLD."revision", OLD."state", NEW."state" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- A stranded notice now joins its reader's one open bell row for that detector in that project
-- (`stranded-issues.ts:sweepGroupKey`), where it used to found a row per sweep minute, so one
-- project's strands read as dozens of rows naming no project (F10). The rows already open are
-- folded the same way: each open per-minute row's records move to one row per reader, detector
-- and project, unread while any row folded into it was unread, and the per-minute rows go.
-- A row carrying a record with no project is left as it is.
CREATE TEMP TABLE "strand_regroup" ON COMMIT DROP AS
SELECT d."id" AS "old_id", d."user_id", d."title", d."read_at", d."created_at", m."notification_id",
       'sweep:' || split_part(d."group_key", ':', 2) || ':' || n."project_id"::text AS "new_key"
  FROM "notification_deliveries" d
  JOIN "notification_delivery_members" m ON m."delivery_id" = d."id"
  JOIN "notifications" n ON n."id" = m."notification_id"
 WHERE d."resolved_notice" = false
   AND d."group_key" ~ '^sweep:[a-z-]+:[0-9]+$'
   AND NOT EXISTS (
     SELECT 1 FROM "notification_delivery_members" m2
       JOIN "notifications" n2 ON n2."id" = m2."notification_id"
      WHERE m2."delivery_id" = d."id" AND n2."project_id" IS NULL);
--> statement-breakpoint
INSERT INTO "notification_deliveries" ("user_id", "channel", "group_key", "title", "read_at", "resolved_notice", "created_at")
SELECT "user_id", 'bell', "new_key", min("title"),
       CASE WHEN bool_and("read_at" IS NOT NULL) THEN max("read_at") END, false, max("created_at")
  FROM "strand_regroup"
 GROUP BY "user_id", "new_key";
--> statement-breakpoint
INSERT INTO "notification_delivery_members" ("delivery_id", "notification_id")
SELECT d."id", r."notification_id"
  FROM "strand_regroup" r
  JOIN "notification_deliveries" d
    ON d."user_id" = r."user_id" AND d."group_key" = r."new_key" AND d."resolved_notice" = false
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "notification_deliveries" WHERE "id" IN (SELECT "old_id" FROM "strand_regroup");
--> statement-breakpoint
-- The same for a question chat cannot carry (`question-ledger.ts:reportUndeliverable`): its open
-- rows fold to one per reader, project and reason, titled with the reason (F12).
CREATE TEMP TABLE "undeliverable_regroup" ON COMMIT DROP AS
SELECT d."id" AS "old_id", d."user_id", d."read_at", d."created_at", m."notification_id",
       'question-undeliverable:' || n."project_id"::text || ':' || q."last_error" AS "new_key",
       p."name" || ': questions are not posted to chat — ' || q."last_error" AS "new_title"
  FROM "notification_deliveries" d
  JOIN "notification_delivery_members" m ON m."delivery_id" = d."id"
  JOIN "notifications" n ON n."id" = m."notification_id"
  JOIN "projects" p ON p."id" = n."project_id"
  JOIN LATERAL (
    SELECT rq."last_error" FROM "rocketchat_question_deliveries" rq
     WHERE rq."question_id"::text = substring(n."resolution_key" from 'rocketchat-question-undeliverable:(.*)')
       AND rq."status" = 'undeliverable' AND rq."last_error" IS NOT NULL
     ORDER BY rq."updated_at" DESC LIMIT 1) q ON true
 WHERE d."resolved_notice" = false AND d."group_key" IS NULL
   AND n."resolution_key" LIKE 'rocketchat-question-undeliverable:%';
--> statement-breakpoint
INSERT INTO "notification_deliveries" ("user_id", "channel", "group_key", "title", "read_at", "resolved_notice", "created_at")
SELECT "user_id", 'bell', "new_key", min("new_title"),
       CASE WHEN bool_and("read_at" IS NOT NULL) THEN max("read_at") END, false, max("created_at")
  FROM "undeliverable_regroup"
 GROUP BY "user_id", "new_key";
--> statement-breakpoint
INSERT INTO "notification_delivery_members" ("delivery_id", "notification_id")
SELECT d."id", r."notification_id"
  FROM "undeliverable_regroup" r
  JOIN "notification_deliveries" d
    ON d."user_id" = r."user_id" AND d."group_key" = r."new_key" AND d."resolved_notice" = false
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "notification_deliveries" WHERE "id" IN (SELECT "old_id" FROM "undeliverable_regroup");
