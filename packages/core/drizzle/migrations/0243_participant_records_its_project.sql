-- ISS-1003 — a conversation's scope leaves the table that says what an agent may DO.
--
-- `conversations/scope.ts:derivedScope` joined `conversation_participants` to `project_members`,
-- so a room's scope was read out of the very row `revokeAgentAccount` deletes. Two correct rules
-- then closed on each other: an empty scope is refused to every reader (`CONVERSATION_NO_SCOPE`),
-- and the last handle may not be removed (`CONVERSATION_LAST_HANDLE`). Revoking an agent therefore
-- left every room where it was the only handle readable by nobody and repairable by no supported
-- call. Removing authority is a security action and must always succeed; it may not also empty a
-- room.
--
-- The fact was already known at the door: `participants.ts:addHandle` resolves the handle's
-- project in order to check the caller's role on it. This stores that answer instead of
-- recomputing it from a table that answers a different question.
--
-- Two consequences, both wanted. Revoking an agent removes its authority and leaves the
-- conversation readable, with the agent showing as unreachable. And an agent later given a second
-- project membership no longer silently widens every conversation it already sits in.
--
-- Not idempotent, and it does not need to be: the whole run is one transaction.
--
-- SEARCH PATH — pinned and every relation qualified, for the reason 0240 carries.
SET LOCAL search_path = public, pg_temp;--> statement-breakpoint

ALTER TABLE "conversation_participants" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade;--> statement-breakpoint

-- REFUSE, before the backfill: a live handle whose scope today is not exactly one project.
--
-- The value being stored is "the project this handle was added FOR", and until now that was
-- derived as the set of the agent's project memberships. Where that set is not a single project
-- the derivation and the column disagree, and nothing here may choose for the operator: a handle
-- with none is a room whose scope is already empty (the deadlock this migration removes, which has
-- to be repaired by giving the agent its membership back before the column can record it), and a
-- handle with several is a room whose scope would silently NARROW to whichever row was picked.
-- Both are named rather than resolved.
DO $$
DECLARE bad RECORD;
BEGIN
  SELECT cp.id, cp.conversation_id, cp.user_id, count(pm.project_id) AS n
  INTO bad
  FROM public.conversation_participants cp
  LEFT JOIN public.project_members pm ON pm.user_id = cp.user_id
  WHERE cp.kind = 'handle' AND cp.removed_at IS NULL
  GROUP BY cp.id, cp.conversation_id, cp.user_id
  HAVING count(pm.project_id) <> 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'conversation_participants row % (conversation %, handle %) derives % project(s) and the column records exactly one; a handle with none is a room already unreadable and a handle with several is a scope this migration will not narrow for you (ISS-1003)',
      bad.id, bad.conversation_id, bad.user_id, bad.n;
  END IF;
END $$;--> statement-breakpoint

-- Store the answer the join was computing. Identical scope, one read instead of a join, and no
-- longer erased by a revoke.
UPDATE "conversation_participants" cp
SET "project_id" = pm."project_id"
FROM "project_members" pm
WHERE pm."user_id" = cp."user_id" AND cp."kind" = 'handle' AND cp."removed_at" IS NULL;--> statement-breakpoint

-- A REMOVED handle keeps its null: it contributes to no scope, so there is nothing to record, and
-- inventing one from today's memberships would date the row wrong. The CHECK admits it for the
-- same reason it admits a person.
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_handle_has_project"
  CHECK ("kind" <> 'handle' OR "removed_at" IS NOT NULL OR "project_id" IS NOT NULL);--> statement-breakpoint

CREATE INDEX "conversation_participants_project_idx"
  ON "conversation_participants" ("project_id");
