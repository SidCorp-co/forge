-- ISS-1225 — a `blocks` edge can say it holds its dependent until the blocker has SHIPPED.
--
-- Until now every live `blocks` edge released its dependent once the blocker reached `developed`,
-- so on a project whose release is a publish nothing could say "not until the publish happened".
-- `holds_until` is that statement, per edge: `settled` (today's reading) or `shipped` (released only
-- when the blocker is `closed`). The default is `settled`, so every existing row, and every writer
-- that never heard of the column, reads exactly as it did.
--
-- Additive: one NOT NULL column with a constant default, which Postgres fills without rewriting
-- rows, so no existing row can violate it and old code keeps working. The CHECK holds on every
-- existing row (all are `settled`) and refuses, at the database, a value outside the two and a
-- `shipped` hold on an edge that is not `blocks`, the two refusals the write doors also make by name.
-- Rollback: the column can stay unread, or
--   ALTER TABLE "issue_dependencies" DROP CONSTRAINT "issue_dependencies_holds_until_chk";
--   ALTER TABLE "issue_dependencies" DROP COLUMN "holds_until";
-- an edge written `shipped` then reads as `settled` again, and its dependent is admissible at `developed`.
ALTER TABLE "issue_dependencies" ADD COLUMN "holds_until" text DEFAULT 'settled' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_holds_until_chk" CHECK ("issue_dependencies"."holds_until" IN ('settled', 'shipped') AND ("issue_dependencies"."holds_until" = 'settled' OR "issue_dependencies"."kind" = 'blocks'));