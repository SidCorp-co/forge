-- A room is held per binding, never per bot connection (ISS-933). `support_rooms_connection_rid_uq`
-- let one row per bot connection hold a chat room, so a binding switched off (or no longer naming the
-- room) kept the room, and an active binding naming the same rid on the same connection could never
-- be placed: its insert hit the index and the room went unanswered (sid-desk behind sidcorp-mail's
-- inactive 325f2300; forge's Forge-Communicate behind adminhub-fe's inactive 19fed7ab). Two active
-- bindings naming one rid are each placed; their prompts, not the schema, say who answers.
-- `support_rooms_binding_rid_uq` stays: one room per binding and rid.
--
-- ROLLBACK: CREATE UNIQUE INDEX IF NOT EXISTS "support_rooms_connection_rid_uq" ON "support_rooms" ("connection_id", "rid");
-- (refused while two rows of one connection hold one rid)

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DROP INDEX IF EXISTS "support_rooms_connection_rid_uq";
