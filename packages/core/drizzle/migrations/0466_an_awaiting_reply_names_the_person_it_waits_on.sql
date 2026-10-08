-- "Waiting on you" put an agent's question to the newest person who wrote before the reply row
-- (ISS-277, probe P7): in a two-person room, a colleague who wrote while the turn answering the
-- owner was still out was told the agent waited on them, and the owner, who was asked, read Done.
-- awaits_reply_from is the fact instead: the person the turn that wrote this reply answered, recorded
-- beside awaits_reply when the reply is. It may be set only on a row that awaits a reply. A row that
-- awaits one and names nobody (every row written before this, and one whose person was deleted)
-- waits on nobody: a miss, never a claim. There is no backfill, since nothing recorded whom those
-- turns answered and a guess from who wrote when is the rule P7 failed.
--
-- ROLLBACK: ALTER TABLE conversation_messages DROP CONSTRAINT conversation_messages_awaits_reply_from_awaits,
-- DROP COLUMN awaits_reply_from.

ALTER TABLE "conversation_messages" ADD COLUMN "awaits_reply_from" uuid;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_awaits_reply_from_users_id_fk" FOREIGN KEY ("awaits_reply_from") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_awaits_reply_from_awaits" CHECK ("conversation_messages"."awaits_reply_from" IS NULL OR "conversation_messages"."awaits_reply");
