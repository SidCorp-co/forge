-- ISS-763 (REQ-77 BC-1): a project's channel agent is one session serving every group its
-- rocketchat binding names under `agent`. Each such group keeps a support_rooms row of its own (its
-- threads, actions and record stay per group), of the new kind `agent`, and all of them share the
-- one agent account and the one session. So the room kind check admits `agent`, and the principal
-- stays unique only among rooms that are not a channel agent's. Additive: no row is rewritten, so
-- nothing is lost.
--
-- ROLLBACK (only while no room is a channel agent's):
--   DROP INDEX support_rooms_principal_uq;
--   CREATE UNIQUE INDEX support_rooms_principal_uq ON support_rooms (principal_user_id);
--   ALTER TABLE support_rooms DROP CONSTRAINT support_rooms_kind_chk,
--     ADD CONSTRAINT support_rooms_kind_chk CHECK (kind IN ('support', 'operations'));
ALTER TABLE "support_rooms" DROP CONSTRAINT IF EXISTS "support_rooms_kind_chk";
--> statement-breakpoint
ALTER TABLE "support_rooms" ADD CONSTRAINT "support_rooms_kind_chk" CHECK ("support_rooms"."kind" IN ('support', 'operations', 'agent'));
--> statement-breakpoint
DROP INDEX IF EXISTS "support_rooms_principal_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "support_rooms_principal_uq" ON "support_rooms" USING btree ("principal_user_id") WHERE "support_rooms"."kind" <> 'agent';
