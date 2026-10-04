-- One durable outbox (ISS-166). pipeline_outbox holds every event another module reacts to, written
-- in the act's own transaction and typed by `type`; the in-memory hooks bus is gone. A row's
-- columns are its type, its project and issue, its payload and its delivery; `delivered` names the
-- consumers already through, so a redelivery runs only the ones that failed.
ALTER TABLE "pipeline_outbox" ADD COLUMN "type" text;--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD COLUMN "delivered" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint

-- Every row so far is an issue move the status trigger wrote; its columns become the payload the
-- `issue.transitioned` consumers read.
UPDATE "pipeline_outbox" SET
  "type" = 'issue.transitioned',
  "payload" = jsonb_build_object(
    'entity', 'issue',
    'id', "issue_id",
    'projectId', "project_id",
    'issueId', "issue_id",
    'from', "from_status",
    'to', "to_status",
    'reason', "reason",
    'actor', CASE
      WHEN "actor_type" = 'user' AND "actor_id" IS NOT NULL AND "actor_agency" IS NOT NULL
        THEN jsonb_build_object('type', 'user', 'id', "actor_id", 'agency', "actor_agency")
      ELSE jsonb_build_object('type', 'device', 'id', coalesce("actor_id", '<system>'), 'agency', 'agent')
    END,
    'at', to_char("created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );--> statement-breakpoint

-- An undelivered move whose feed line the old subscriber already wrote is not written twice.
UPDATE "pipeline_outbox" o SET "delivered" = ARRAY['activity-feed']
 WHERE o."processed_at" IS NULL
   AND EXISTS (
     SELECT 1 FROM "activity_log" a
      WHERE a."dedupe_key" = 'transition:' || o."id"::text AND a."action" = 'issue.statusChanged'
   );--> statement-breakpoint

ALTER TABLE "pipeline_outbox" ALTER COLUMN "type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ALTER COLUMN "payload" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ALTER COLUMN "issue_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_outbox" DROP CONSTRAINT IF EXISTS "pipeline_outbox_user_actor_has_agency";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" DROP COLUMN "from_status";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" DROP COLUMN "to_status";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" DROP COLUMN "actor_id";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" DROP COLUMN "actor_type";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" DROP COLUMN "actor_agency";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" DROP COLUMN "reason";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_type_chk" CHECK ("type" IN ('issue.created', 'issue.updated', 'issue.transitioned', 'job.transitioned', 'run.transitioned', 'dependency.changed', 'comment.created', 'comment.updated', 'comment.deleted', 'comment.mentioned', 'question.answered', 'task.created', 'task.updated', 'task.deleted', 'schedule.fired', 'notification.created', 'notification.read', 'user.preferencesChanged', 'skill.syncRequested', 'skill.registered', 'skill.globalUpdated', 'runner.provisionRequested', 'runner.provisionStatus'));--> statement-breakpoint

-- The kernel transition writes each move's event itself (`lifecycle/transition.ts`), so the
-- issues trigger that wrote it from session settings is dropped.
DROP TRIGGER IF EXISTS "trg_issues_status_outbox" ON "issues";--> statement-breakpoint
DROP FUNCTION IF EXISTS pipeline_outbox_on_status_change();--> statement-breakpoint

-- A Rocket.Chat reply's `comment.created` is written with the comment now, so the announcement
-- lease that stood in for it goes. An announcement still owed becomes its event here.
INSERT INTO "pipeline_outbox" ("type", "issue_id", "project_id", "payload")
SELECT 'comment.created', i."id", i."project_id", jsonb_build_object(
    'issueId', i."id",
    'projectId', i."project_id",
    'actor', jsonb_build_object('type', 'user', 'id', c."author_id", 'agency', 'human'),
    'authored', 'human',
    'commentId', c."id",
    'body', c."body",
    'parentId', NULL
  )
  FROM "rocketchat_comment_mirrors" m
  JOIN "comments" c ON c."id" = m."comment_id"
  JOIN "issues" i ON i."id" = c."issue_id"
 WHERE m."direction" = 'inbound' AND m."announced_at" IS NULL AND c."author_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "rocketchat_comment_mirrors" DROP COLUMN "announced_at";--> statement-breakpoint
ALTER TABLE "rocketchat_comment_mirrors" DROP COLUMN "announce_lease_until";
