CREATE TABLE "session_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"intent_id" text NOT NULL,
	"body" text,
	"send_requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"send_confirmed_at" timestamp with time zone,
	"send_outcome" text,
	"applied_at" timestamp with time zone,
	"applied_turn" integer
);
--> statement-breakpoint
ALTER TABLE "session_inbox" ADD CONSTRAINT "session_inbox_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_inbox_intent_unique" ON "session_inbox" USING btree ("agent_session_id","kind","intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_inbox_seq_unique" ON "session_inbox" USING btree ("agent_session_id","seq");--> statement-breakpoint
CREATE INDEX "session_inbox_unresolved_idx" ON "session_inbox" USING btree ("send_requested_at") WHERE send_confirmed_at IS NULL OR (send_outcome = 'unknown' AND applied_at IS NULL);