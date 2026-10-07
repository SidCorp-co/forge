-- The chat audit log's rows are copied into `chat_turn_archive` by 0394, before it drops the table, so
-- a database promoted across 0394 keeps every turn. A database that ran 0394 before the copy was
-- added (dev did) never created the archive; this gives it the same table, empty, so every database
-- carries one schema. On a database 0394 already archived into, both statements do nothing.
CREATE TABLE IF NOT EXISTS "chat_turn_archive" (
  "id" uuid PRIMARY KEY NOT NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "project_slug" text NOT NULL,
  "session_id" text,
  "user_key" text,
  "source" text NOT NULL,
  "query" text NOT NULL,
  "reply" text,
  "model" text,
  "tool_calls" jsonb,
  "usage" jsonb,
  "iterations" integer NOT NULL,
  "duration_ms" integer,
  "error" text,
  "created_at" timestamp with time zone NOT NULL,
  "archived_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_turn_archive_project_created_idx" ON "chat_turn_archive" USING btree ("project_id","created_at");
