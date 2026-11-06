-- ISS-1042 — who decides an act in a room comes from the project's rulings: a `rule` knowledge entry
-- whose `metadata.deciders` names each member and the acts they decide, written by a master through
-- the knowledge door. Migration 0609's room-typed decider (a channel rule's `decider` and
-- `decider_acts`, and the writer's account id kept only to judge whether its writer could name one)
-- goes, with its check.
--
-- Nothing is dropped unread: each live rule (not removed) that names a decider is carried into a
-- `rule` entry of its channel's project, slug `room-decider-<rule id>`, its words and writer kept in
-- the body and `metadata.carriedFrom`. A rule that stood under 0609 (its writer the owner a room of
-- the group's bindings names, or a member a person confirmed as Technical or Maintenance) carries
-- `metadata.deciders`, so its decider still counts; one that did not stand names nobody, as before,
-- and keeps what it named under `carriedFrom.decider` for a master to rule on. A removed rule keeps
-- its row and words, as every removed rule does.
--
-- ROLLBACK (the carried entries stay; the columns come back empty):
--   ALTER TABLE "support_channel_rules" ADD COLUMN IF NOT EXISTS "author_key" text;
--   ALTER TABLE "support_channel_rules" ADD COLUMN IF NOT EXISTS "decider" text;
--   ALTER TABLE "support_channel_rules" ADD COLUMN IF NOT EXISTS "decider_acts" text[];

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
INSERT INTO "knowledge_entries" ("project_id", "kind", "slug", "title", "body", "injection", "confidence", "authored_by", "metadata")
SELECT d."project_id", 'rule', 'room-decider-' || d."id"::text,
       'Decider carried from a channel rule: @' || d."decider",
       'Carried by migration 0611 (ISS-1042) from the channel rule @' || coalesce(d."author", 'unknown')
         || ' wrote on ' || to_char(d."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ' in group ' || d."rid"
         || ': "' || d."text" || '". '
         || CASE WHEN d."stood"
              THEN 'It named @' || d."decider" || ' as the one who decides ' || array_to_string(d."decider_acts", ', ')
                   || ', and its writer could name one, so it stands here as a ruling.'
              ELSE 'It named @' || d."decider" || ' for ' || array_to_string(d."decider_acts", ', ')
                   || ', but its writer could not name a decider, so it names nobody; a master that finds a ruling for it adds metadata.deciders.'
            END,
       'on_demand', 'inferred', 'imported',
       jsonb_build_object(
         'carriedFrom', jsonb_build_object(
           'rule', d."id", 'rid', d."rid", 'author', d."author", 'stood', d."stood",
           'decider', jsonb_build_object('member', d."decider", 'acts', to_jsonb(d."decider_acts"))))
       || CASE WHEN d."stood"
            THEN jsonb_build_object('deciders', jsonb_build_array(
                   jsonb_build_object('member', d."decider", 'acts', to_jsonb(d."decider_acts"))))
            ELSE '{}'::jsonb
          END
  FROM (
    SELECT r."id", r."text", r."author", r."decider", r."decider_acts", r."created_at", c."project_id", c."rid",
           (EXISTS (
              SELECT 1 FROM "support_rooms" sr
                JOIN "integration_bindings" b ON b."id" = sr."binding_id"
               WHERE sr."project_id" = c."project_id" AND sr."rid" = c."rid" AND sr."kind" <> 'operations'
                 AND r."author_key" IS NOT NULL
                 AND r."author_key" = (CASE WHEN sr."kind" = 'agent' THEN b."config" -> 'agent' ELSE b."config" -> 'support' END) -> 'grants' ->> 'owner')
            OR EXISTS (
              SELECT 1 FROM "support_channel_members" m
               WHERE m."channel_id" = r."channel_id" AND lower(m."username") = lower(r."author")
                 AND m."state" = 'confirmed' AND m."roles" && ARRAY['technical', 'maintenance']::text[])) AS "stood"
      FROM "support_channel_rules" r
      JOIN "support_channels" c ON c."id" = r."channel_id"
     WHERE r."decider" IS NOT NULL AND r."removed_at" IS NULL
  ) d
ON CONFLICT ("project_id", "slug") DO NOTHING;--> statement-breakpoint
ALTER TABLE "support_channel_rules" DROP CONSTRAINT IF EXISTS "support_channel_rules_decider_chk";--> statement-breakpoint
ALTER TABLE "support_channel_rules" DROP COLUMN IF EXISTS "decider_acts";--> statement-breakpoint
ALTER TABLE "support_channel_rules" DROP COLUMN IF EXISTS "decider";--> statement-breakpoint
ALTER TABLE "support_channel_rules" DROP COLUMN IF EXISTS "author_key";
