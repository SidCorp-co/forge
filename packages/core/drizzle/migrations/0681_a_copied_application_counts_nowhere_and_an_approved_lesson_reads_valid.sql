-- ISS-1251 round 5. Every lessons map ended with the example `Lessons applied: L-3, L-7`, and agents
-- copied it: the only applications forge-dev ever recorded were L-3 and L-7, once each, by the steward,
-- and neither lesson is about anything a steward act does (L-3: test a decision's aging; L-7: check a
-- credential's fence). An output whose applications are exactly its project's lessons 3 and 7 is that
-- copy: each is marked wrongly applied, saying why, and its lesson's applied count loses it, so it
-- counts toward no use and no fold. The example now reads `L-<n>, …`
-- (`lessons/block.ts:APPLIED_TAIL`), and a mark made later takes its application off the count the
-- same way (`lessons/confusions.ts:markApplication`).
-- Only those applications and their lessons' counts change; an output naming 3 and 7 among others,
-- or one already marked, is left as it is. Re-run, it finds nothing left to mark.
--
-- Second, an approved lesson reads valid. A confusion settled on a lesson a landing had invalidated
-- moved it back to approved and left `invalid_at` set, so it was served and read invalid at once; a
-- settlement is now its re-check and clears the mark (`lessons/confusions.ts:decideConfusion`). The
-- ten lessons forge-dev held invalid on `card:support.member` were re-anchored that way (ISS-1251 c4).
-- Only an approved lesson's mark is cleared; a held one still waits on its re-check.
--
-- ROLLBACK (the marks are this migration's own reason; the counts take them back):
--   WITH unmarked AS (
--     UPDATE "lesson_applications" SET "wrong_at" = NULL, "wrong_by" = NULL, "wrong_reason" = NULL
--      WHERE "wrong_reason" LIKE 'Copied from the lessons map''s example%' RETURNING "lesson_id")
--   UPDATE "lessons" l SET "applied_count" = l."applied_count" + u.n
--     FROM (SELECT "lesson_id", count(*)::int AS n FROM unmarked GROUP BY 1) u WHERE l."id" = u."lesson_id";
--   The cleared marks are not restored: an approved lesson read invalid was the defect.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
WITH copied AS (
  SELECT la."project_id", la."output_kind", la."output_ref"
    FROM "lesson_applications" la
    JOIN "lessons" l ON l."id" = la."lesson_id"
   WHERE la."wrong_at" IS NULL
   GROUP BY 1, 2, 3
  HAVING array_agg(l."number" ORDER BY l."number") = ARRAY[3, 7]
), marked AS (
  UPDATE "lesson_applications" la
     SET "wrong_at" = now(),
         "wrong_reason" = 'Copied from the lessons map''s example `Lessons applied: L-3, L-7`, not applied (ISS-1251)'
    FROM copied c
   WHERE la."project_id" = c."project_id"
     AND la."output_kind" = c."output_kind"
     AND la."output_ref" = c."output_ref"
     AND la."wrong_at" IS NULL
  RETURNING la."lesson_id"
)
UPDATE "lessons" l
   SET "applied_count" = GREATEST(l."applied_count" - m.n, 0)
  FROM (SELECT "lesson_id", count(*)::int AS n FROM marked GROUP BY 1) m
 WHERE l."id" = m."lesson_id";--> statement-breakpoint
UPDATE "lessons"
   SET "invalid_at" = NULL, "invalid_by" = NULL, "updated_at" = now()
 WHERE "status" = 'approved' AND "invalid_at" IS NOT NULL;
