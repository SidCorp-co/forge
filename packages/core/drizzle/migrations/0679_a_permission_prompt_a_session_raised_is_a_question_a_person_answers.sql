-- A Claude Code permission prompt a resident session raised is relayed by the runner's PermissionRequest
-- hook as a question a person allows or denies (ISS-1268 B3): origin kind `permission_prompt`, naming
-- the session and the tool, on no issue.

ALTER TABLE "agent_questions" DROP CONSTRAINT "agent_questions_origin_shape_chk";--> statement-breakpoint
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
          "agent_questions"."origin" ->> 'kind' = 'permission_prompt'
          and "agent_questions"."origin" ? 'session'
          and "agent_questions"."origin" ? 'tool'
          and "agent_questions"."issue_id" is null
        )
        or (
          "agent_questions"."origin" ->> 'kind' = 'conversation'
          and "agent_questions"."origin" ? 'adapter'
          and "agent_questions"."origin" ? 'venueId'
          and "agent_questions"."origin" ? 'conversationId'
          and "agent_questions"."origin" ? 'windowId'
        )
      ));
