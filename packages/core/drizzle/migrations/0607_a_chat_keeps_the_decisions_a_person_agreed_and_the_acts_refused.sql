-- ISS-624 (REQ-41 BC-24, BC-25, BC-28; judge K66 on dev.304). Two tables the `assistant` domain owns,
-- neither rewriting a row:
--   1. chat_decision_sets: the Needs-you decisions a chat put to the person with put_decision_set.
--      "open them" in a later message acts on the newest set whole (act_on_decisions), so the agreed
--      set is held here and not only by the prompt: the model can neither widen nor narrow it.
--   2. chat_decision_failures: each refused act on a decision in a conversation, a card press the
--      browser reported failed with core's refusal or an act_on_decisions item core refused. Two on
--      one decision and it is not offered a third time, and Forge's own feedback records it
--      (feedback_key, on the refusal that made it twice).
--
-- ROLLBACK (nothing else reads them):
--   DROP TABLE chat_decision_failures; DROP TABLE chat_decision_sets;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_decision_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE cascade,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"window_id" uuid NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_decision_sets_items_chk" CHECK (jsonb_typeof("items") = 'array' AND jsonb_array_length("items") > 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_decision_sets_conversation_idx" ON "chat_decision_sets" ("conversation_id", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_decision_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE cascade,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"person_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"decision_id" text NOT NULL,
	"item_key" text NOT NULL,
	"via" text NOT NULL,
	"code" text NOT NULL,
	"detail" text NOT NULL,
	"feedback_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_decision_failures_via_chk" CHECK ("via" IN ('card', 'chat'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_decision_failures_decision_idx" ON "chat_decision_failures" ("conversation_id", "decision_id");
