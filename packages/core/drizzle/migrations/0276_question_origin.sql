ALTER TABLE "agent_questions" ADD COLUMN "origin" jsonb;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_origin_shape_chk" CHECK ("agent_questions"."origin" is null or (
        ("agent_questions"."origin" ->> 'kind' = 'unresolved' and "agent_questions"."origin" ? 'reason')
        or (
          "agent_questions"."origin" ->> 'kind' = 'conversation'
          and "agent_questions"."origin" ? 'adapter'
          and "agent_questions"."origin" ? 'venueId'
          and "agent_questions"."origin" ? 'conversationId'
          and "agent_questions"."origin" ? 'windowId'
        )
      ));