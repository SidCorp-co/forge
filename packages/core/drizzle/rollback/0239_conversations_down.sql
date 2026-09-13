-- The reverse of 0239_conversations.sql, run BY HAND against a deployment whose
-- code has been reverted past ISS-1001. Drizzle has no down migrations; this
-- file is what makes the forward drop a relocation rather than a discard, and it
-- is exercised in `tests/integration/conversations-migration-e2e.test.ts` so it
-- is proved rather than described.
--
-- Run it, then delete this migration's bookkeeping row so the reverted build
-- does not consider it applied:
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794096000000;
--
-- TWO HALVES, AND THEY ARE NOT THE SAME GUARANTEE.
--   * A conversation carrying `origin` was consumed from `chat_sessions`, and
--     every field comes back off that jsonb — no membership is consulted, so the
--     reconstruction is exact however the memberships have since moved.
--   * A conversation opened AFTER the forward migration carries no `origin`. It
--     is rebuilt anyway, because dropping it would lose every room that spoke
--     between the deploy and the rollback — which is user data. Its `project_id`
--     is taken from its handle's oldest membership, which is the only source
--     there is and is NOT byte-exact by construction: the row it rebuilds never
--     existed before.
--
-- `chat_logs.session_id` stays nullable. The forward migration relaxed it so a
-- one-shot relay turn could belong to no conversation; restoring the constraint
-- would mean deleting those audit rows, and an audit row is not ours to discard
-- to tidy a column. The reverted code writes a value into it either way.

CREATE TABLE IF NOT EXISTS "chat_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
  "user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "user_key" text,
  "title" text,
  "source" text DEFAULT 'web' NOT NULL,
  "messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "chat_sessions_project_updated_idx" ON "chat_sessions" ("project_id","updated_at");
CREATE INDEX IF NOT EXISTS "chat_sessions_user_idx" ON "chat_sessions" ("user_id");

-- Half one: the consumed rows, off `origin` alone.
INSERT INTO chat_sessions (id, project_id, user_id, user_key, title, source, messages, created_at, updated_at)
SELECT
  (c.origin ->> 'chatSessionId')::uuid,
  (c.origin ->> 'projectId')::uuid,
  NULLIF(c.origin ->> 'userId', '')::uuid,
  c.origin ->> 'userKey',
  c.title,
  c.origin ->> 'source',
  -- the blob comes back from `origin`, not from the message rows: the rows keep
  -- what this schema models, and rebuilding from them would re-synthesize a `ts`
  -- the element may never have carried and drop any key nothing here reads. Turns
  -- SPOKEN SINCE the forward migration are not in it and are not meant to be —
  -- this half restores the row as it was consumed; half two rebuilds what came
  -- after from the rows, which is the only source those have.
  COALESCE(c.origin -> 'messages', '[]'::jsonb),
  (c.origin ->> 'createdAt')::timestamptz,
  (c.origin ->> 'updatedAt')::timestamptz
FROM conversations c
WHERE c.origin IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Half two: everything opened since, from the row itself.
INSERT INTO chat_sessions (id, project_id, user_id, user_key, title, source, messages, created_at, updated_at)
SELECT
  c.id,
  (
    SELECT pm.project_id FROM conversation_participants cp
    JOIN project_members pm ON pm.user_id = cp.user_id
    WHERE cp.conversation_id = c.id AND cp.kind = 'handle' AND cp.removed_at IS NULL
    ORDER BY pm.created_at, pm.project_id
    LIMIT 1
  ),
  (
    SELECT cp.user_id FROM conversation_participants cp
    WHERE cp.conversation_id = c.id AND cp.kind = 'person' AND cp.removed_at IS NULL AND cp.user_id IS NOT NULL
    ORDER BY cp.added_at LIMIT 1
  ),
  (
    SELECT cp.external_key FROM conversation_participants cp
    WHERE cp.conversation_id = c.id AND cp.kind = 'person' AND cp.removed_at IS NULL AND cp.external_key IS NOT NULL
    ORDER BY cp.added_at LIMIT 1
  ),
  c.title,
  c.adapter,
  COALESCE((
    SELECT jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'role', m.role,
        'content', m.content,
        'ts', to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'images', m.images
      )) ORDER BY m.seq
    )
    FROM conversation_messages m
    WHERE m.conversation_id = c.id AND m.silence_reason IS NULL
  ), '[]'::jsonb),
  c.created_at,
  c.updated_at
FROM conversations c
WHERE c.origin IS NULL
  AND EXISTS (
    SELECT 1 FROM conversation_participants cp
    JOIN project_members pm ON pm.user_id = cp.user_id
    WHERE cp.conversation_id = c.id AND cp.kind = 'handle' AND cp.removed_at IS NULL
  )
ON CONFLICT (id) DO NOTHING;

-- The principals this migration minted, and no others: a handle that predated it
-- is indistinguishable from one it created on every signal EXCEPT this marker,
-- which is why the forward migration writes it.
DELETE FROM users u
WHERE u.kind = 'agent'
  AND u.id IN (
    SELECT DISTINCT NULLIF(c.origin ->> 'mintedHandleUserId', '')::uuid
    FROM conversations c
    WHERE c.origin IS NOT NULL AND c.origin ->> 'mintedHandleUserId' IS NOT NULL
  )
  AND NOT EXISTS (SELECT 1 FROM personal_access_tokens t WHERE t.user_id = u.id);

DROP TABLE IF EXISTS "conversation_messages";
DROP TABLE IF EXISTS "conversation_participants";
DROP TABLE IF EXISTS "conversations";
