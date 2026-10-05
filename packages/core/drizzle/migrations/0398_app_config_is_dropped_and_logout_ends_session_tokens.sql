-- ISS-219: app_config, which nothing writes, is dropped, and a user carries the second its session
-- tokens became invalid.
--
-- ROLLBACK: users.tokens_valid_after can be dropped by hand (logout then ends only refresh tokens).
-- app_config is dropped with its contents; it can be recreated empty from 0037's definition, and a
-- row in it would only ever have restated the defaults the code now holds.
--
-- app_config's three readers now use the defaults every project without a row already read: the
-- deployment's chat provider and model, both retrieval switches off, no system prompt override. A row
-- holding anything else is a setting the drop would silently discard, so it aborts this migration
-- naming that row, and is never deleted here.

-- LOCKS. Drizzle applies every pending file in ONE transaction, so a lock taken here is held until
-- the batch commits. Every table this file touches is locked up front, in one fixed order
-- (alphabetical), before any statement holds a lock a live session could be waiting behind; a table
-- that stays busy past lock_timeout fails the deploy loudly instead of deadlocking mid-file. A table
-- this database never had is skipped.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_config', 'users'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', to_regclass(t));
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

DO $$
DECLARE r record;
BEGIN
  IF to_regclass('app_config') IS NULL THEN
    RETURN;
  END IF;
  SELECT id, project_id INTO r FROM "app_config"
  WHERE "chat_provider_id" IS NOT NULL
     OR "chat_model" IS NOT NULL
     OR "chat_model_by_kind" <> '{}'::jsonb
     OR "retrieval_rerank"
     OR "retrieval_expand_relations"
     OR "system_prompt_override" IS NOT NULL
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'app_config % (project %) holds a setting other than the default, which the code no longer reads; move it into the project config document or clear it before this migration', r.id, r.project_id;
  END IF;
END $$;--> statement-breakpoint
DROP TABLE IF EXISTS "app_config";--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN "tokens_valid_after" timestamp with time zone;
