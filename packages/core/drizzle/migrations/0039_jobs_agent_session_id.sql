-- ISS-4: link pipeline jobs to their observability `agent_sessions` row so
-- /pipeline + issue detail surfaces can render pipeline jobs alongside
-- interactive chat sessions. Bare uuid (no FK) to mirror the existing
-- notifications.agent_session_id pattern; adding the FK later is additive.

ALTER TABLE "jobs" ADD COLUMN "agent_session_id" uuid;--> statement-breakpoint

CREATE INDEX "jobs_agent_session_id_idx" ON "jobs" USING btree ("agent_session_id");
