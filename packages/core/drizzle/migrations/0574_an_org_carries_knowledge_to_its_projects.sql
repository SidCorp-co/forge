-- An organisation's own knowledge (ISS-861): an entry written once reaches the prompt of every
-- project of the org, ahead of the project's own always-on entries; a project entry under the same
-- slug takes its place. A sibling of knowledge_entries, which stays project-scoped. New table, no
-- existing row moves.
--
-- ROLLBACK: drop the table; every project then reads its own knowledge alone, as before.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_knowledge_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"injection" text DEFAULT 'always' NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_knowledge_entries_injection_chk" CHECK ("injection" IN ('always', 'on_demand'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_knowledge_entries_org_slug_uq" ON "org_knowledge_entries" USING btree ("org_id","slug");
