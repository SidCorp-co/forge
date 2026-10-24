-- A design names no module where its project declares no module label (ISS-609, FB-192, REQ-36
-- BC-1, BC-5). The CHECK took at least one module, so a project with no module labels could record
-- no design and none of its issues could reach build. An empty `modules` now holds the whole
-- project: the scope lock reads it as meeting every other design of that project. Whether a
-- project may take one is core's rule (`issues/design-rules.ts:resolveModules`), not the table's,
-- since it follows the project's labels. No row changes: every design written so far names one.
--
-- ROLLBACK: put back `cardinality("modules") BETWEEN 1 AND 50`, which fails while any design
-- naming no module stands; record those again naming a module first.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "issue_designs" DROP CONSTRAINT IF EXISTS "issue_designs_modules_chk";--> statement-breakpoint
ALTER TABLE "issue_designs" ADD CONSTRAINT "issue_designs_modules_chk" CHECK (cardinality("modules") <= 50);
