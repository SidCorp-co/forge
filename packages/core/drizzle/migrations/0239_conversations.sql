-- ISS-1001 — a conversation becomes a durable row, and `chat_sessions` is replaced.
--
-- Order matters and each step is why the next is safe: create, then refuse a row
-- that cannot be represented, then mint or reuse one handle per project, then
-- copy, then ASSERT the copy source-driven, and only then drop. Nothing is
-- nulled, emptied or deleted to make the schema apply.
--
-- The reverse is `packages/core/drizzle/rollback/0239_conversations_down.sql`
-- and it is executable, which is why this migration is a relocation rather than
-- a discard: every field of every consumed row is reachable from
-- `conversations.origin` without consulting a membership.
--
-- Not idempotent, and it does not need to be: the whole run is ONE transaction
-- (which it was not until this issue removed `0067_unify_runners.sql`'s stray
-- `COMMIT;`), so an abort anywhere below leaves the database exactly as it was
-- and the retry starts from the same place this run did.
--
-- WHAT THIS CANNOT CARRY, AND SAYS SO RATHER THAN PRETENDING: which Rocket.Chat
-- room a migrated transcript belonged to. That mapping only ever lived in
-- `RocketChatConnectionManager.sessionByConversation`, an in-process Map, so it
-- is already lost on every core restart and there is nothing on disk to read it
-- from. A migrated row keeps every message it holds under the venue
-- `legacy:<chat_session_id>`; the room it came from opens a fresh conversation
-- under its real venue key the next time it speaks. That is the defect being
-- fixed, and the orphaned history is its last bill.

CREATE TABLE IF NOT EXISTS "conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "adapter" text NOT NULL,
  "external_id" text NOT NULL,
  "shape" text DEFAULT 'direct' NOT NULL,
  "title" text,
  "origin" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "conversations_adapter_known" CHECK ("adapter" IN ('web','widget','rocketchat','telegram')),
  CONSTRAINT "conversations_shape_known" CHECK ("shape" IN ('direct','group'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_venue_unique" ON "conversations" ("adapter","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_updated_idx" ON "conversations" ("updated_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "conversation_participants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE cascade,
  "external_key" text,
  "label" text,
  "added_by" uuid REFERENCES "users"("id") ON DELETE set null,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  "removed_at" timestamp with time zone,
  CONSTRAINT "conversation_participants_kind_known" CHECK ("kind" IN ('person','handle')),
  -- a handle is an agent account and contributes the room's scope, so it cannot be a row with nobody in it
  CONSTRAINT "conversation_participants_handle_has_user" CHECK ("kind" <> 'handle' OR "user_id" IS NOT NULL),
  -- a person is a Forge user or the key their transport gave; with neither there is nobody to add
  CONSTRAINT "conversation_participants_person_identified" CHECK ("kind" <> 'person' OR "user_id" IS NOT NULL OR "external_key" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_participants_live_user_unique" ON "conversation_participants" ("conversation_id","user_id") WHERE removed_at IS NULL AND user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_participants_conversation_idx" ON "conversation_participants" ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_participants_user_idx" ON "conversation_participants" ("user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "conversation_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE cascade,
  "seq" integer NOT NULL,
  "role" text NOT NULL,
  "author_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "author_label" text,
  "content" text NOT NULL,
  "images" jsonb,
  "delivery_proof" jsonb,
  "silence_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "conversation_messages_role_known" CHECK ("role" IN ('user','assistant','system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_messages_seq_unique" ON "conversation_messages" ("conversation_id","seq");--> statement-breakpoint

-- A one-shot relay turn belongs to no conversation and used to be given a throwaway
-- `chat_sessions` row purely so this column could be filled.
ALTER TABLE "chat_logs" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint

-- Refuse a row the new schema cannot represent, naming it, before anything is written.
DO $$
DECLARE bad record;
BEGIN
  SELECT cs.id, cs.project_id INTO bad
  FROM chat_sessions cs
  WHERE jsonb_typeof(cs.messages) <> 'array'
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'chat_sessions row % (project %) holds a % where an array of messages was required; it cannot be represented as conversation_messages and nothing here will empty it to make the schema apply',
      bad.id, bad.project_id, (SELECT jsonb_typeof(messages) FROM chat_sessions WHERE id = bad.id);
  END IF;

  -- A row naming no project, or a project belonging to no organization, would be
  -- the third unrepresentable shape — and it is NOT checked here, deliberately.
  -- `chat_sessions.project_id` is NOT NULL with a foreign key onto `projects`,
  -- and `projects.org_id` is NOT NULL with a foreign key onto `organizations`,
  -- so neither shape can exist to be found. A guard for it would raise on no
  -- input this database can hold, which is not a defence: it is a line that
  -- always passes, reads like one that checked something, and cannot be shown
  -- red by any planted row. If either column is ever relaxed, this is the
  -- comment that says what to put back.

  SELECT cs.id, cs.project_id INTO bad
  FROM chat_sessions cs
  WHERE cs.source NOT IN ('web','widget','rocketchat','telegram')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'chat_sessions row % carries source "%" which is no conversation adapter',
      bad.id, (SELECT source FROM chat_sessions WHERE id = bad.id);
  END IF;
END $$;--> statement-breakpoint

-- One handle per project that owns chat rows: reused where the project already
-- has an agent account, minted where it does not — with its org and project
-- memberships and NO access token, because a handle is a name in a room.
CREATE TEMP TABLE _iss1001_handles ON COMMIT DROP AS
SELECT
  cs.project_id,
  (
    SELECT u.id FROM users u
    JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = cs.project_id
    WHERE u.kind = 'agent'
    ORDER BY u.created_at, u.id
    LIMIT 1
  ) AS existing_user_id,
  NULL::uuid AS minted_user_id
FROM (SELECT DISTINCT project_id FROM chat_sessions) cs;--> statement-breakpoint

-- The id is allocated FIRST so the user this project got is unambiguous: matching
-- a freshly inserted row back by its handle name would tie two projects whose
-- slugs sanitize alike to each other's principal.
UPDATE _iss1001_handles SET minted_user_id = gen_random_uuid() WHERE existing_user_id IS NULL;--> statement-breakpoint

INSERT INTO users (id, email, kind, password_hash, email_verified_at)
SELECT
  h.minted_user_id,
  (CASE
     WHEN trim(both '-' from regexp_replace(lower(p.slug), '[^a-z0-9]+', '-', 'g')) ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
       THEN trim(both '-' from regexp_replace(lower(p.slug), '[^a-z0-9]+', '-', 'g'))
     ELSE 'agent-' || left(p.id::text, 8)
   END) || '.' || left(md5(random()::text || clock_timestamp()::text), 12) || '@agents.forge.invalid',
  'agent',
  NULL,
  now()
FROM _iss1001_handles h
JOIN projects p ON p.id = h.project_id
WHERE h.minted_user_id IS NOT NULL;--> statement-breakpoint

INSERT INTO organization_members (org_id, user_id, role)
SELECT p.org_id, h.minted_user_id, 'member'
FROM _iss1001_handles h JOIN projects p ON p.id = h.project_id
WHERE h.minted_user_id IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO project_members (user_id, project_id, role)
SELECT h.minted_user_id, h.project_id, 'member'
FROM _iss1001_handles h
WHERE h.minted_user_id IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Every chat session becomes one direct conversation carrying its source row whole.
INSERT INTO conversations (id, adapter, external_id, shape, title, origin, created_at, updated_at)
-- the conversation KEEPS the chat session's id, so the `chat_logs.session_id`
-- values already written keep naming the same thing they always did
SELECT
  cs.id,
  cs.source,
  'legacy:' || cs.id::text,
  'direct',
  cs.title,
  jsonb_build_object(
    'chatSessionId', cs.id::text,
    'projectId', cs.project_id::text,
    'userId', cs.user_id::text,
    'userKey', cs.user_key,
    'source', cs.source,
    'createdAt', to_char(cs.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(cs.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'mintedHandleUserId', h.minted_user_id::text
  ),
  cs.created_at,
  cs.updated_at
FROM chat_sessions cs
JOIN _iss1001_handles h ON h.project_id = cs.project_id;--> statement-breakpoint

INSERT INTO conversation_participants (conversation_id, kind, user_id, added_at)
SELECT cs.id, 'handle', COALESCE(h.existing_user_id, h.minted_user_id), cs.created_at
FROM chat_sessions cs
JOIN _iss1001_handles h ON h.project_id = cs.project_id;--> statement-breakpoint

-- A person joins only where the source row recorded one. 34 of the 35 rows on
-- forge-beta record neither a user nor a key: the Rocket.Chat fast path ran with
-- no `userId` and `user_key` is null on every row in the table. Inventing a
-- stand-in would put a principal in a room that never spoke.
INSERT INTO conversation_participants (conversation_id, kind, user_id, external_key, added_at)
SELECT cs.id, 'person', cs.user_id, cs.user_key, cs.created_at
FROM chat_sessions cs
WHERE cs.user_id IS NOT NULL OR cs.user_key IS NOT NULL;--> statement-breakpoint

-- Each element of the blob becomes one row, in its original order. The stored
-- element carries a role and a text and no author, so the author is the handle
-- for an assistant turn, the recorded person for a user turn, and nobody where
-- the row recorded none.
INSERT INTO conversation_messages
  (conversation_id, seq, role, author_user_id, author_label, content, images, created_at)
SELECT
  cs.id,
  (t.ord - 1)::int,
  COALESCE(t.step ->> 'role', 'user'),
  CASE
    WHEN t.step ->> 'role' = 'assistant' THEN COALESCE(h.existing_user_id, h.minted_user_id)
    WHEN t.step ->> 'role' = 'user' THEN cs.user_id
    ELSE NULL
  END,
  CASE WHEN t.step ->> 'role' = 'user' THEN cs.user_key ELSE NULL END,
  COALESCE(t.step ->> 'content', ''),
  CASE WHEN jsonb_typeof(t.step -> 'images') = 'array' THEN t.step -> 'images' ELSE NULL END,
  COALESCE((t.step ->> 'ts')::timestamptz, cs.created_at)
FROM chat_sessions cs
JOIN _iss1001_handles h ON h.project_id = cs.project_id
CROSS JOIN LATERAL jsonb_array_elements(cs.messages) WITH ORDINALITY AS t(step, ord)
WHERE t.step ->> 'role' IN ('user','assistant','system');--> statement-breakpoint

-- The assertion, source-driven and run AFTER the copy. Every clause anti-joins
-- from `chat_sessions` outward, so an omission fails rather than a count matching.
DO $$
DECLARE bad record;
BEGIN
  SELECT cs.id INTO bad FROM chat_sessions cs
  WHERE (SELECT count(*) FROM conversations c WHERE c.origin ->> 'chatSessionId' = cs.id::text) <> 1
  LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'chat_sessions row % did not become exactly one conversation', bad.id; END IF;

  SELECT cs.id INTO bad FROM chat_sessions cs JOIN conversations c ON c.id = cs.id
  WHERE c.shape <> 'direct' OR c.adapter <> cs.source OR c.title IS DISTINCT FROM cs.title
  LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'conversation for chat_sessions row % does not carry its shape, adapter or title', bad.id; END IF;

  SELECT cs.id INTO bad FROM chat_sessions cs
  WHERE (
    SELECT count(*) FROM conversation_participants cp
    JOIN project_members pm ON pm.user_id = cp.user_id AND pm.project_id = cs.project_id
    WHERE cp.conversation_id = cs.id AND cp.kind = 'handle' AND cp.removed_at IS NULL
  ) <> 1
  LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'conversation for chat_sessions row % has no single handle on project %', bad.id, (SELECT project_id FROM chat_sessions WHERE id = bad.id); END IF;

  SELECT cs.id INTO bad FROM chat_sessions cs
  WHERE (SELECT count(*) FROM conversation_participants cp WHERE cp.conversation_id = cs.id AND cp.kind = 'person')
        <> (CASE WHEN cs.user_id IS NOT NULL OR cs.user_key IS NOT NULL THEN 1 ELSE 0 END)
  LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'conversation for chat_sessions row % carries a person it did not record, or lost the one it did', bad.id; END IF;

  -- every source element has a row at its own ordinal with its own role and text
  SELECT cs.id INTO bad FROM chat_sessions cs
  CROSS JOIN LATERAL jsonb_array_elements(cs.messages) WITH ORDINALITY AS t(step, ord)
  WHERE t.step ->> 'role' IN ('user','assistant','system')
    AND NOT EXISTS (
      SELECT 1 FROM conversation_messages cm
      WHERE cm.conversation_id = cs.id
        AND cm.seq = (t.ord - 1)::int
        AND cm.role = t.step ->> 'role'
        AND cm.content = COALESCE(t.step ->> 'content', '')
    )
  LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'chat_sessions row % has a stored message with no row at its own position, role and text', bad.id; END IF;

  -- and no row exists that no source element accounts for
  SELECT cm.conversation_id AS id INTO bad FROM conversation_messages cm
  JOIN chat_sessions cs ON cs.id = cm.conversation_id
  WHERE NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(cs.messages) WITH ORDINALITY AS t(step, ord)
    WHERE (t.ord - 1)::int = cm.seq
      AND t.step ->> 'role' = cm.role
      AND COALESCE(t.step ->> 'content', '') = cm.content
  )
  LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'conversation % holds a message no chat_sessions element accounts for', bad.id; END IF;
END $$;--> statement-breakpoint

DROP TABLE "chat_sessions";
