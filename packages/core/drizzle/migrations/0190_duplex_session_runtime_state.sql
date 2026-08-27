ALTER TABLE "agent_sessions" ADD COLUMN "runtime_state" text;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "last_inbox_seq" integer DEFAULT 0 NOT NULL;