-- ISS-1384 — an issue declares where its own work lands, so a git project's change that lands no
-- file can carry the outside-git mark instead of borrowing a commit it did not make.
--
-- `declared_landing_shape` is the issue's own answer to `landingShape`; NULL answers the project's
-- kind exactly as before. Which shape every door judges against is decided by
-- `packages/core/src/issues/landing-evidence.ts` alone, and the write is refused while a merged
-- mark stands so a mark is never re-judged on a shape it was not made under.
--
-- Additive and nullable: every existing row reads back NULL and answers its project's shape as it
-- does today, no row's data moves, and the CHECK holds on every row because none carries a value.
-- Rollback: the column can stay unread, or `ALTER TABLE issues DROP COLUMN declared_landing_shape`.
ALTER TABLE "issues" ADD COLUMN "declared_landing_shape" text;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_declared_landing_shape_chk" CHECK ("issues"."declared_landing_shape" IS NULL OR "issues"."declared_landing_shape" IN ('git', 'outside_git'));
