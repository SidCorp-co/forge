-- An approve gate on a channel document is an agent_questions row with no issue and no session, so
-- it parks no run (ISS-22). One open gate question per document, held by the database.

ALTER TABLE "agent_questions" DROP CONSTRAINT "agent_questions_origin_shape_chk";--> statement-breakpoint
CREATE UNIQUE INDEX "agent_questions_channel_gate_open_uq" ON "agent_questions" USING btree (("origin" ->> 'documentId')) WHERE "agent_questions"."status" = 'open' and "agent_questions"."origin" ->> 'kind' = 'channel_gate';--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_origin_shape_chk" CHECK ("agent_questions"."origin" is null or (
        ("agent_questions"."origin" ->> 'kind' = 'unresolved' and "agent_questions"."origin" ? 'reason')
        or (
          "agent_questions"."origin" ->> 'kind' = 'channel_gate'
          and "agent_questions"."origin" ? 'documentId'
          and "agent_questions"."origin" ? 'number'
          and "agent_questions"."issue_id" is null
          and "agent_questions"."agent_session_id" is null
        )
        or (
          "agent_questions"."origin" ->> 'kind' = 'conversation'
          and "agent_questions"."origin" ? 'adapter'
          and "agent_questions"."origin" ? 'venueId'
          and "agent_questions"."origin" ? 'conversationId'
          and "agent_questions"."origin" ? 'windowId'
        )
      ));
