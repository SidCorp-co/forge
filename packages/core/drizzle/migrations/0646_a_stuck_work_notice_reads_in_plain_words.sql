-- A stuck-work notice reads in plain words (ISS-1184, REQ-12 BC-6). Its title where the detector
-- named none was "Pipeline wedge: <hop> hop miss on <entity>" and its body "WHERE: … / WHY: … /
-- WHAT: …", the detector's own vocabulary with the entity's raw id; the bell showed both. Core now
-- writes them as `packages/core/src/pipeline/wedge-words.ts` says, and this rewrites the rows written
-- before, a notice's title and its bell row's alike, so the bell holds one wording and no read-time
-- branch keeps the old one alive.
--
-- Backfill only: a row matching neither old shape is left as it is (a caller's own title, or one a
-- person may have read in other words). Re-running it finds nothing left to rewrite.
--
-- ROLLBACK: none kept; the old words were the defect, and the hop and the entity are in the logs.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
WITH subject(entity, words) AS (
  VALUES ('job', 'A job'), ('session', 'An agent session'), ('run', 'A run'), ('issue', 'An issue'),
         ('capacity', 'Work for the project’s runners'), ('runner', 'A runner')
), how(hop, words) AS (
  VALUES ('ack', 'was handed out and never confirmed'), ('claim', 'was never picked up by a machine'),
         ('heartbeat', 'stopped answering'), ('result', 'ended without reporting a result'),
         ('dispatch', 'is waiting and nothing starts it')
)
UPDATE "notifications" n SET "title" = subject.words || ' ' || how.words
  FROM subject, how
 WHERE n."type" = 'pipeline_wedge'
   AND n."title" = 'Pipeline wedge: ' || how.hop || ' hop miss on ' || subject.entity;--> statement-breakpoint
WITH subject(entity, words) AS (
  VALUES ('job', 'A job'), ('session', 'An agent session'), ('run', 'A run'), ('issue', 'An issue'),
         ('capacity', 'Work for the project’s runners'), ('runner', 'A runner')
), how(hop, words) AS (
  VALUES ('ack', 'was handed out and never confirmed'), ('claim', 'was never picked up by a machine'),
         ('heartbeat', 'stopped answering'), ('result', 'ended without reporting a result'),
         ('dispatch', 'is waiting and nothing starts it')
)
UPDATE "notification_deliveries" d SET "title" = subject.words || ' ' || how.words
  FROM subject, how
 WHERE d."title" = 'Pipeline wedge: ' || how.hop || ' hop miss on ' || subject.entity
   AND EXISTS (
     SELECT 1 FROM "notification_delivery_members" dm
       JOIN "notifications" w ON w."id" = dm."notification_id"
      WHERE dm."delivery_id" = d."id" AND w."type" = 'pipeline_wedge'
   );--> statement-breakpoint
UPDATE "notifications" n
   SET "body" = upper(left(old.m[1], 1)) || substr(old.m[1], 2)
                || CASE WHEN old.m[1] ~ '[.!?]$' THEN '' ELSE '.' END
                || E'\n' || 'Next: ' || old.m[2]
  FROM (
    SELECT "id", regexp_match("body", E'^WHERE: [^\\n]*\\nWHY: (.*)\\nWHAT: (.*)$') AS m
      FROM "notifications"
     WHERE "type" = 'pipeline_wedge' AND "body" LIKE 'WHERE: %'
  ) old
 WHERE n."id" = old."id" AND old.m IS NOT NULL;
