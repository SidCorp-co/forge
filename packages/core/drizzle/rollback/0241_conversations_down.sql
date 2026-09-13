-- The reverse of 0241_conversations.sql, run BY HAND against a deployment whose
-- code has been reverted past ISS-1001. Drizzle has no down migrations; this
-- file is what makes the forward drop a relocation rather than a discard, and it
-- is exercised in `tests/integration/conversations-migration-reverse-e2e.test.ts`
-- so it is proved rather than described.
--
-- Run it whole, from the file — it opens and closes its own transaction, so a
-- failure partway commits nothing and the final COMMIT acts as a rollback on an
-- aborted transaction:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0241_conversations_down.sql
-- Then delete this migration's bookkeeping row so the reverted build does not
-- consider it applied:
--   DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794268800000;
--
-- TWO HALVES, AND THEY ARE NOT THE SAME GUARANTEE.
--   * A conversation carrying `origin` was consumed from `chat_sessions`, and
--     every field comes back off that jsonb — no membership is consulted, so the
--     reconstruction is exact however the memberships have since moved. What that
--     room has said SINCE is appended from its message rows, because those rows
--     are the only source for them and half two does not reach a row that carries
--     an `origin`.
--   * A conversation opened AFTER the forward migration carries no `origin`. It
--     is rebuilt anyway, because dropping it would lose every room that spoke
--     between the deploy and the rollback — which is user data. Its `project_id`
--     is taken from its handle's oldest membership, which is the only source
--     there is and is NOT byte-exact by construction: the row it rebuilds never
--     existed before.
--
--   * A SILENCE belongs to neither half: it is a row `chat_sessions` cannot hold, so it
--     is archived into `chat_session_silences` rather than dropped or forced into the
--     replayed blob. See the block that writes it, below.
--
-- `chat_logs.session_id` stays nullable. The forward migration relaxed it so a
-- one-shot relay turn could belong to no conversation; restoring the constraint
-- would mean deleting those audit rows, and an audit row is not ours to discard
-- to tidy a column. The reverted code writes a value into it either way.

-- ONE TRANSACTION, opened here, because this file is run BY HAND and not by the
-- migrator. Under `psql -f` in autocommit every statement below commits on its
-- own, so a failure partway leaves half a reverse standing — tables recreated,
-- some rows back, principals already deleted — and nothing says which half ran.
-- `SET LOCAL` would also have had no transaction to bind to and would have warned
-- and done nothing, leaving the search_path defence off in the one file that runs
-- in a session nobody controls.
--
-- This is the opposite rule from a migration under `drizzle/migrations/`, where a
-- file that opens a transaction ENDS the migrator's own — which is exactly what
-- `0067_unify_runners.sql` did for 171 migrations. The gate in
-- `db/migrations-journal.test.ts` scans that directory and not this one, for this
-- reason.
BEGIN;

-- The same search_path pin the forward migration carries, for the same reason:
-- `pg_temp` is searched before `public` for relations unless it is named, and
-- this file is run BY HAND in a session whose path nobody controls. Naming it
-- last demotes it; every relation below is schema-qualified as well.
SET LOCAL search_path = public, pg_temp;

CREATE TABLE IF NOT EXISTS public.chat_sessions (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES public.projects("id") ON DELETE cascade,
  "user_id" uuid REFERENCES public.users("id") ON DELETE set null,
  "user_key" text,
  "title" text,
  "source" text DEFAULT 'web' NOT NULL,
  "messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "chat_sessions_project_updated_idx" ON public.chat_sessions ("project_id","updated_at");
CREATE INDEX IF NOT EXISTS "chat_sessions_user_idx" ON public.chat_sessions ("user_id");

-- Half one: the consumed rows, off `origin` alone.
INSERT INTO public.chat_sessions (id, project_id, user_id, user_key, title, source, messages, created_at, updated_at)
SELECT
  (c.origin ->> 'chatSessionId')::uuid,
  (c.origin ->> 'projectId')::uuid,
  NULLIF(c.origin ->> 'userId', '')::uuid,
  c.origin ->> 'userKey',
  -- the CURRENT title, deliberately, and not `origin ->> 'title'`: a rename made after
  -- the deploy is activity of the same kind as the messages appended below it, and a
  -- reverse that undid renames while keeping new messages would be exact about neither.
  -- The as-consumed title is in `origin` for anyone who needs it (ISS-1001).
  c.title,
  c.origin ->> 'source',
  -- The consumed blob VERBATIM, then everything the room has said SINCE. The
  -- verbatim half matters because the rows keep only what this schema models:
  -- rebuilding a consumed element from its row would re-synthesize a `ts` it may
  -- never have carried and drop any key nothing here reads.
  --
  -- The second half is not optional and half two does not cover it: half two takes
  -- `origin IS NULL` only, so a room that was migrated and then went on talking
  -- would come back holding the transcript it had on deploy day and nothing after
  -- it — silently, since the row looks complete. Rows at or past the consumed
  -- blob's own length are the ones this migration did not put there, and they come
  -- back in the only shape there is for them, which is the same shape half two
  -- uses.
  COALESCE(c.origin -> 'messages', '[]'::jsonb) || COALESCE((
    SELECT jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'role', m.role,
        'content', m.content,
        'ts', to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'images', m.images
      )) ORDER BY m.seq
    )
    FROM public.conversation_messages m
    WHERE m.conversation_id = c.id
      AND m.silence_reason IS NULL
      AND m.seq >= jsonb_array_length(COALESCE(c.origin -> 'messages', '[]'::jsonb))
  ), '[]'::jsonb),
  (c.origin ->> 'createdAt')::timestamptz,
  -- the conversation's own clock, which `appendMessage` bumps: a room that spoke
  -- after the deploy did not stop being updated on deploy day.
  c.updated_at
FROM public.conversations c
WHERE c.origin IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- Half two: everything opened since, from the row itself.
INSERT INTO public.chat_sessions (id, project_id, user_id, user_key, title, source, messages, created_at, updated_at)
SELECT
  c.id,
  (
    SELECT pm.project_id FROM public.conversation_participants cp
    JOIN public.project_members pm ON pm.user_id = cp.user_id
    WHERE cp.conversation_id = c.id AND cp.kind = 'handle' AND cp.removed_at IS NULL
    ORDER BY pm.created_at, pm.project_id
    LIMIT 1
  ),
  (
    SELECT cp.user_id FROM public.conversation_participants cp
    WHERE cp.conversation_id = c.id AND cp.kind = 'person' AND cp.removed_at IS NULL AND cp.user_id IS NOT NULL
    ORDER BY cp.added_at LIMIT 1
  ),
  (
    SELECT cp.external_key FROM public.conversation_participants cp
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
        'ts', to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'images', m.images
      )) ORDER BY m.seq
    )
    FROM public.conversation_messages m
    WHERE m.conversation_id = c.id AND m.silence_reason IS NULL
  ), '[]'::jsonb),
  c.created_at,
  c.updated_at
FROM public.conversations c
WHERE c.origin IS NULL
  AND EXISTS (
    SELECT 1 FROM public.conversation_participants cp
    JOIN public.project_members pm ON pm.user_id = cp.user_id
    WHERE cp.conversation_id = c.id AND cp.kind = 'handle' AND cp.removed_at IS NULL
  )
ON CONFLICT (id) DO NOTHING;

-- SILENCES ARE ARCHIVED, NOT DISCARDED — and not put back into the blob either.
-- A silence is a turn that produced no text, kept as its reason; `chat_sessions.messages`
-- has no shape for one. The reverted code replays that array to the provider verbatim and
-- never wrote an element with empty text (it appends an assistant message only when the
-- final text is non-empty), so restoring a silence as an empty assistant element would
-- hand the reverted deployment a prompt shape it has never produced — and an empty content
-- block is refused outright by part of the provider set. Dropping them instead would
-- silently delete the one field the new model was introduced to keep, and leave the user
-- message above it reading as unanswered.
-- So they leave the dropped table into one of their own, in full, and this reverse is not
-- finished until whoever ran it has read that table and dropped it deliberately:
--   SELECT * FROM chat_session_silences;  -- then: DROP TABLE chat_session_silences;
CREATE TABLE IF NOT EXISTS public.chat_session_silences (
  "session_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "reason" text NOT NULL,
  "author_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("session_id", "seq")
);

INSERT INTO public.chat_session_silences (session_id, seq, reason, author_user_id, created_at)
SELECT m.conversation_id, m.seq, m.silence_reason, m.author_user_id, m.created_at
FROM public.conversation_messages m
WHERE m.silence_reason IS NOT NULL
ON CONFLICT DO NOTHING;

-- A minted handle that has since been given an access token is somebody's decision
-- and it is REFUSED BY NAME rather than worked around in either direction. Deleting
-- it silently takes a credential something may be authenticating with; keeping it
-- silently leaves a principal behind while reporting a clean reverse, which is the
-- one thing criterion 41 says this file does not do. Whoever minted the token
-- decides: revoke it and run this again, or keep the account and say so.
DO $$
DECLARE stuck uuid;
BEGIN
  SELECT u.id INTO stuck
  FROM public.users u
  WHERE u.kind = 'agent'
    AND u.id IN (
      SELECT DISTINCT NULLIF(c.origin ->> 'mintedHandleUserId', '')::uuid
      FROM public.conversations c
      WHERE c.origin IS NOT NULL AND c.origin ->> 'mintedHandleUserId' IS NOT NULL
    )
    AND EXISTS (SELECT 1 FROM public.personal_access_tokens t WHERE t.user_id = u.id)
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'agent account % was minted by 0241_conversations.sql and has since been given an access token; this reverse deletes exactly the accounts that migration created, so it stops here rather than taking a live credential or reporting a clean reverse that left a principal behind. Revoke the token and run this again, or delete this statement deliberately and record that the account stays.', stuck;
  END IF;
END $$;

-- The principals this migration minted, and no others: a handle that predated it
-- is indistinguishable from one it created on every signal EXCEPT this marker,
-- which is why the forward migration writes it.
DELETE FROM public.users u
WHERE u.kind = 'agent'
  AND u.id IN (
    SELECT DISTINCT NULLIF(c.origin ->> 'mintedHandleUserId', '')::uuid
    FROM public.conversations c
    WHERE c.origin IS NOT NULL AND c.origin ->> 'mintedHandleUserId' IS NOT NULL
  );

DROP TABLE IF EXISTS public.conversation_messages;
DROP TABLE IF EXISTS public.conversation_participants;
DROP TABLE IF EXISTS public.conversations;

COMMIT;
