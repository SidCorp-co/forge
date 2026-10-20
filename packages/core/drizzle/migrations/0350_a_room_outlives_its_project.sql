-- ISS-1229 r23 — the master's ruling on judge-66's finding: a room whose project was deleted was
-- about no project, so every door refused it (CONVERSATION_NO_SCOPE), its creator's included, and it
-- could never be deleted. A room now belongs to an organization and remembers who opened it: once no
-- project is left in it, its creator or an admin of that organization can still reach it to delete it.
--
-- org_id is read from the project a handle was added for (a live one first, then the earliest), else
-- the project a consumed chat session named; a room whose every project is already gone and whose
-- origin names none keeps org_id NULL, and its creator alone can delete it. created_by is the person
-- a consumed chat session belonged to, else the first person to add anyone to the room (a web room
-- adds its opener first, by themselves).
--
-- Rollback: ALTER TABLE conversations DROP COLUMN org_id, DROP COLUMN created_by; nothing else
-- reads them.
ALTER TABLE conversations
  ADD COLUMN org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX conversations_org_idx ON conversations (org_id);
--> statement-breakpoint
DO $$
DECLARE
  by_handle integer;
  by_origin integer;
  orphaned integer;
  opened integer;
BEGIN
  UPDATE conversations c
     SET org_id = found.org_id
    FROM (
      SELECT DISTINCT ON (cp.conversation_id) cp.conversation_id, p.org_id
        FROM conversation_participants cp
        JOIN projects p ON p.id = cp.project_id
       WHERE cp.kind = 'handle'
       ORDER BY cp.conversation_id, (cp.removed_at IS NOT NULL), cp.added_at
    ) found
   WHERE found.conversation_id = c.id;
  GET DIAGNOSTICS by_handle = ROW_COUNT;

  UPDATE conversations c
     SET org_id = p.org_id
    FROM projects p
   WHERE c.org_id IS NULL
     AND c.origin->>'projectId' IS NOT NULL
     AND p.id::text = c.origin->>'projectId';
  GET DIAGNOSTICS by_origin = ROW_COUNT;

  UPDATE conversations c
     SET created_by = u.id
    FROM users u
   WHERE c.origin->>'userId' IS NOT NULL
     AND u.id::text = c.origin->>'userId';

  UPDATE conversations c
     SET created_by = first.added_by
    FROM (
      SELECT DISTINCT ON (cp.conversation_id) cp.conversation_id, cp.added_by
        FROM conversation_participants cp
       WHERE cp.added_by IS NOT NULL
       ORDER BY cp.conversation_id, cp.added_at, cp.id
    ) first
   WHERE first.conversation_id = c.id
     AND c.created_by IS NULL;
  GET DIAGNOSTICS opened = ROW_COUNT;

  SELECT count(*) INTO orphaned FROM conversations WHERE org_id IS NULL;
  RAISE NOTICE '0350: % room(s) took their organization from an agent''s project, % from the chat session they consumed; % room(s) found none; % room(s) took their creator from who first added someone',
    by_handle, by_origin, orphaned, opened;
END $$;
