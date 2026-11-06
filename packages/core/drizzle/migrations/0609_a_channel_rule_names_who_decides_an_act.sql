-- ISS-1000 — a channel rule may name a member as the person who decides an act (a filing, a fix, a
-- deploy, a build, a host command). Their own request for that act is their agreement while the
-- rule's writer is the owner the binding names or a member a person confirmed as Technical or
-- Maintenance, so the room's brief and the agreement rule read one record. The writer's chat account
-- id is kept with the rule, since the owner is known by that id and never by a name. Rules written
-- before this name no decider and keep no account id; nothing is backfilled.
--
-- ROLLBACK:
--   ALTER TABLE "support_channel_rules" DROP CONSTRAINT IF EXISTS "support_channel_rules_decider_chk";
--   ALTER TABLE "support_channel_rules" DROP COLUMN IF EXISTS "decider_acts";
--   ALTER TABLE "support_channel_rules" DROP COLUMN IF EXISTS "decider";
--   ALTER TABLE "support_channel_rules" DROP COLUMN IF EXISTS "author_key";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "support_channel_rules" ADD COLUMN IF NOT EXISTS "author_key" text;--> statement-breakpoint
ALTER TABLE "support_channel_rules" ADD COLUMN IF NOT EXISTS "decider" text;--> statement-breakpoint
ALTER TABLE "support_channel_rules" ADD COLUMN IF NOT EXISTS "decider_acts" text[];--> statement-breakpoint
ALTER TABLE "support_channel_rules" DROP CONSTRAINT IF EXISTS "support_channel_rules_decider_chk";--> statement-breakpoint
ALTER TABLE "support_channel_rules" ADD CONSTRAINT "support_channel_rules_decider_chk" CHECK (("decider" IS NULL) = ("decider_acts" IS NULL) AND ("decider" IS NULL OR ("message_id" IS NOT NULL AND "author_key" IS NOT NULL AND cardinality("decider_acts") > 0 AND "decider_acts" <@ ARRAY['fix', 'filing', 'deploy', 'command', 'build']::text[])));
