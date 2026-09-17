-- ISS-1016 — the indexes the two REST issue lists and the issue search needed.
--
-- Additive in every statement: one extension and six indexes. No column, no
-- constraint, no drop, no row written, and every reader already running keeps
-- working. Running it backwards is `drizzle/rollback/0262_down.sql` — six
-- `DROP INDEX IF EXISTS` and one `DROP EXTENSION IF EXISTS` — and nothing is lost.
--
-- Measured on the beta deployment 2026-09-17, before this landed: `issues`
-- 431,875 sequential scans for 2,215,065,552 tuples over 6,651 live rows, with
-- `issues_ident_search_idx` at 14 MB and `idx_scan` = 0 for as long as the
-- counters had run. That zero is not neglect. The search predicate ORs four
-- leading-`%` ILIKEs with the `ident_search @@` arm, and Postgres can index an
-- OR only when EVERY arm is indexable — so one unindexable arm made the whole
-- predicate a scan and the GIN index unreachable. The four trigram indexes here
-- are what make the other arms indexable, and therefore what make the
-- identifier index usable at all; the plan becomes a BitmapOr over all five.
--
-- Measured on a local replica of those 6,651 rows, warm cache, median of nine,
-- over five terms times {count, page}: 1,590 ms without the trigram indexes and
-- 613 ms with them. An identifier term (`ISS-1016`) goes 385 ms to 9 ms. One
-- cell regresses — a common term's page, 48 ms to 172 ms, because the bitmap
-- path loses the early stop the `created_at` index gives an unselective
-- predicate — and 172 ms is still below the 274 ms worst case the same five
-- terms measure without any of this. That is the priced trade: 32 MB of index
-- and GIN maintenance on every write to the four columns, against a mean of
-- 61 ms a query rather than 159 ms.
--
-- cm:guard the four trigram indexes are NOT project-scoped, and the composite
-- form was measured rather than assumed: `btree_gin (project_id, col
-- gin_trgm_ops)` came in at 683 ms against the 613 ms below, so it bought
-- nothing today and cost a second extension. It is still the shape to revisit,
-- because the plain index's bitmap spans every project while the query wants
-- one — the condition that ends this choice is a table where no single project
-- is a large fraction of the rows, which at 34 projects and a 1,656-row largest
-- is not yet true.
--
-- cm:guard the two btree indexes are ASCENDING and serve `ORDER BY ... DESC`:
-- Postgres walks a btree backwards at the same cost. Measured on the same
-- replica for a 50-row page of a 1,079-issue project: 516 shared buffers and a
-- top-N sort with no index, 52 buffers and an Index Scan Backward with one.
--
-- cm:guard NOT `CONCURRENTLY`, and it cannot be: `src/db/migrate.ts` wraps the
-- whole run in one transaction and a CONCURRENTLY build is refused inside one.
-- Each statement therefore holds a write lock on `issues` until that
-- transaction commits — 17 seconds for all six at this table's size, measured,
-- and the container is not serving while it migrates. The lock is paid, not
-- avoided, and this comment is where that price is stated.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_title_trgm_idx" ON "issues" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_description_trgm_idx" ON "issues" USING gin ("description" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_plan_trgm_idx" ON "issues" USING gin ("plan" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_acceptance_criteria_trgm_idx" ON "issues" USING gin ("acceptance_criteria" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_project_created_at_idx" ON "issues" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_project_updated_at_idx" ON "issues" USING btree ("project_id","updated_at");
