-- ISS-1229 r24 — the master's ruling on judge-70's finding: the "Project deleted" list showed four
-- identical "Untitled conversation" rows that nothing told apart. A handle's row names the project a
-- room is about, and it cascades away with the project, so once the project is deleted nothing records
-- which one it was. Each room now keeps the names of the projects deleted while it was about them.
--
-- A BEFORE DELETE row trigger on projects sees the room's handle rows before the cascade takes them,
-- and is reached by every delete path, an organization's cascade included. A room orphaned before
-- this migration keeps an empty list: its project's name is gone, and the list says it was not kept.
--
-- Rollback: DROP TRIGGER conversations_remember_deleted_project ON projects;
-- DROP FUNCTION remember_deleted_project_in_rooms(); ALTER TABLE conversations
-- DROP COLUMN deleted_project_names. Only the names recorded since are lost.
ALTER TABLE "conversations" ADD COLUMN "deleted_project_names" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION remember_deleted_project_in_rooms() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE conversations c
     SET deleted_project_names = array_append(c.deleted_project_names, OLD.name)
   WHERE (
           EXISTS (
             SELECT 1
               FROM conversation_participants cp
              WHERE cp.conversation_id = c.id
                AND cp.kind = 'handle'
                AND cp.removed_at IS NULL
                AND cp.project_id = OLD.id
           )
           OR c.origin->>'projectId' = OLD.id::text
         )
     AND NOT (OLD.name = ANY (c.deleted_project_names));
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER conversations_remember_deleted_project
  BEFORE DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION remember_deleted_project_in_rooms();
