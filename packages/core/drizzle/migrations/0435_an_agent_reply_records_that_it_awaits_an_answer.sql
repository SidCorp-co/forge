-- "Waiting on you" was read from the agent's prose: a reply whose end looked like a question made
-- the room wait on the person. Two independent judges found that reading claimed waits that were not
-- real (a question followed by the list that answers it, an echoed question, a URL ending in "?"),
-- and no text rule can tell them apart (ISS-277). awaits_reply is the fact instead: the turn that
-- wrote this reply called await_reply, and the reply delivered is the text it wrote. Only an
-- assistant row that is not a silence may carry it. Every row written before this reads false, so a
-- question asked before the deploy reads as not waiting (a miss, never a claim); there is no backfill,
-- since a backfill from the text would be the same rule again.
--
-- ROLLBACK: ALTER TABLE conversation_messages DROP CONSTRAINT conversation_messages_awaits_reply_agent,
-- DROP COLUMN awaits_reply.

ALTER TABLE "conversation_messages" ADD COLUMN "awaits_reply" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_awaits_reply_agent" CHECK (NOT "conversation_messages"."awaits_reply" OR ("conversation_messages"."role" = 'assistant' AND "conversation_messages"."silence_reason" IS NULL));
