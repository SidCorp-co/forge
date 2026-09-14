-- ISS-1004 — the collector window becomes a row, so a silence has an owner.
--
-- Until now a Rocket.Chat message was gated on an @-mention and, if it passed, answered on its own:
-- one message, one turn, one cost. Two messages typed seconds apart were two decisions, and a turn
-- interrupted by a restart left nothing behind saying it was owed. Nothing recorded that a decision
-- to answer — or to stay silent — had been taken at all, so "why did it not reply?" had no answer a
-- person could read.
--
-- A window is the unit a decision is taken over. It opens on the first message nothing has routed
-- yet, is extended by later ones, and is CLAIMED before it routes, so two cores cannot both answer
-- one thing somebody said. Because it is a row, a restart finds it.
--
-- Three of its properties are database facts rather than conventions, because each of them is a
-- race that a convention loses:
--
--   * `conversation_windows_one_collecting` — one COLLECTING window per conversation. The predicate
--     is `claimed_at IS NULL`, not `closed_at IS NULL`: a window being routed has already read its
--     messages, so a message arriving mid-route must open the SUCCESSOR rather than join a decision
--     that can no longer see it.
--   * `conversation_windows_closed_has_decision` — a closed window always names why, and an open one
--     never pretends to. A close with no decision is the unreadable silence this table removes.
--   * `conversation_windows_closed_was_claimed` — a close is a route, and a route is claimed first.
--
-- `delivery_reserved_at` is stamped BEFORE the text is handed to the transport. A core that posts a
-- reply and dies before recording it leaves that stamp and no delivered row, and the next claimant
-- reads the pair as "a delivery was started and nobody knows how it ended" — which is `undetermined`,
-- and not a second attempt.
--
-- `conversation_messages.external_id` is the transport's own id for an inbound message. Without it a
-- window routed minutes after the message arrived has no way to tell the room's own history reader
-- which lines it has already been handed, and the model is shown the same messages twice — once as
-- seed context and once as its own transcript. Nullable, and null for everything this codebase wrote.
--
-- One new table, one added nullable column, no row rewritten. The rollback is `DROP TABLE` plus
-- `DROP COLUMN`.
--
-- SEARCH PATH — pinned and every relation qualified, for the reason 0240 carries.
SET LOCAL search_path = public, pg_temp;--> statement-breakpoint

CREATE TABLE "conversation_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"adapter" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"extended_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_seq" integer NOT NULL,
	"last_seq" integer NOT NULL,
	"claimed_at" timestamp with time zone,
	"delivery_reserved_at" timestamp with time zone,
	"claimed_by" text,
	"closed_at" timestamp with time zone,
	"decision" text,
	"decision_detail" jsonb,
	CONSTRAINT "conversation_windows_adapter_known" CHECK ("conversation_windows"."adapter" IN ('web','widget','rocketchat','telegram')),
	CONSTRAINT "conversation_windows_decision_known" CHECK ("conversation_windows"."decision" IS NULL OR "conversation_windows"."decision" IN ('answered','nothing-to-say','guard-backoff','guard-agent-loop','guard-dormant','authority-refused','unreachable','undetermined')),
	CONSTRAINT "conversation_windows_closed_has_decision" CHECK (("conversation_windows"."closed_at" IS NULL) = ("conversation_windows"."decision" IS NULL)),
	CONSTRAINT "conversation_windows_closed_was_claimed" CHECK ("conversation_windows"."closed_at" IS NULL OR "conversation_windows"."claimed_at" IS NOT NULL),
	CONSTRAINT "conversation_windows_seq_order" CHECK ("conversation_windows"."last_seq" >= "conversation_windows"."first_seq")
);
--> statement-breakpoint
ALTER TABLE "conversation_windows" ADD CONSTRAINT "conversation_windows_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_windows" ADD CONSTRAINT "conversation_windows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_windows_one_collecting" ON "conversation_windows" USING btree ("conversation_id") WHERE claimed_at IS NULL AND closed_at IS NULL;--> statement-breakpoint
CREATE INDEX "conversation_windows_due_idx" ON "conversation_windows" USING btree ("adapter","extended_at") WHERE closed_at IS NULL;--> statement-breakpoint
CREATE INDEX "conversation_windows_conversation_idx" ON "conversation_windows" USING btree ("conversation_id","closed_at");
--> statement-breakpoint

ALTER TABLE "conversation_messages" ADD COLUMN "external_id" text;
