-- A design approval wrote the merged mark of the issue its revision was drawn under (ISS-262), whatever
-- that issue delivers. An issue linked as the build of a workflow (`workflow_builds`) delivers that build,
-- so a mark the approval wrote on it says a build landed that was never built: the forecast read it as
-- landed, a release could claim it, and the build's own landing met MARK_ALREADY_STANDS. From this change
-- the approval records the revision on a build issue as evidence only
-- (packages/core/src/issues/design-landing.ts:markApprovedDesign); this clears the marks it wrote before.
--
-- WHAT IS CLEARED. A mark the approval wrote, on an issue linked as a build, that no release has read:
-- status neither `awaiting_release` nor `closed` (a released issue's mark is what its release shipped).
-- The approval's writing is read from the row itself: no commit (it never writes one), and its notice
-- (`designLandingNotice`, posted in the decision's transaction, so stamped at the same now() as
-- merged_at) on the issue at exactly merged_at; outside git the landing is also its sentence
-- (`designLandingOf`). merged_at, merged_landing and merged_artifacts are cleared together, and a notice
-- on the issue says why, authored as the approval's notice was.
--
-- WHAT IS KEPT. A design issue's mark (no build link): the revision is its deliverable. A mark another
-- writer made (no approval notice at its stamp). A merge Forge observed.
--
-- WHAT IS REFUSED, BY NAME. A build issue's mark whose landing is the approval's sentence with no approval
-- notice at its stamp (whose it is cannot be read), and an approval's mark that something has since
-- written paths, a target or a non-design artifact onto (clearing it would discard that record).
--
-- ROLLBACK: none in SQL; each cleared mark is named in the notice this posts, with the landing it held,
-- and is re-written by POST /api/issues/:id/merge where a person rules it was right.

DO $$
DECLARE
  sentence CONSTANT text := '^workflow design `[^`]+` revision [0-9]+, approved$';
  notice CONSTANT text := 'Design `%` revision % was approved, and it is this issue''s deliverable, so this issue''s merged mark now records it.%';
  refused text;
BEGIN
  CREATE TEMP TABLE design_marked_build ON COMMIT DROP AS
  SELECT i.id, p.slug, i.iss_seq, i.merged_landing, i.merged_paths, i.merged_target,
         i.merged_artifacts,
         n.author_id AS noticed_by,
         substring(n.body from '^Design (`[^`]+` revision [0-9]+) was approved') AS revision
    FROM issues i
    JOIN projects p ON p.id = i.project_id
    LEFT JOIN LATERAL (
      SELECT c.author_id, c.body FROM comments c
       WHERE c.issue_id = i.id AND c.created_at = i.merged_at AND c.body LIKE notice
       ORDER BY c.id LIMIT 1
    ) n ON true
   WHERE i.merged_at IS NOT NULL
     AND coalesce(trim(i.merged_commit_sha), '') = ''
     AND i.status NOT IN ('awaiting_release', 'closed')
     AND EXISTS (SELECT 1 FROM workflow_builds b WHERE b.issue_id = i.id)
     AND EXISTS (
       SELECT 1 FROM project_workflow_designs d
        WHERE d.design_issue_id = i.id AND d.decision = 'approve'
     );

  SELECT string_agg(format('%s ISS-%s (%s): %s', slug, iss_seq, id, why), '; ' ORDER BY slug, iss_seq)
    INTO refused
    FROM (
      SELECT slug, iss_seq, id,
             CASE
               WHEN noticed_by IS NULL
                 THEN 'its landing is a design approval''s sentence but no approval notice stands at its stamp, so whose mark it is cannot be read'
               ELSE 'the design approval''s mark has since had paths, a target or a non-design artifact written onto it, which clearing would discard'
             END AS why
        FROM design_marked_build
       WHERE (noticed_by IS NULL AND merged_landing ~ sentence)
          OR (noticed_by IS NOT NULL AND (
                merged_paths IS NOT NULL
             OR merged_target IS NOT NULL
             OR (merged_landing IS NOT NULL AND merged_landing !~ sentence)
             OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(coalesce(merged_artifacts, '[]'::jsonb)) a
                   WHERE a ->> 'surface' IS DISTINCT FROM 'design'
                )
          ))
    ) r;
  IF refused IS NOT NULL THEN
    RAISE EXCEPTION 'DESIGN_MARK_UNCLASSIFIED: % — read each issue''s mark and thread, unmark it (DELETE /api/issues/:id/merge) or clear what was written onto it, then deploy again.', refused;
  END IF;

  INSERT INTO comments (issue_id, author_id, body)
  SELECT id, noticed_by,
         'The merged mark the approval of design ' || revision
         || ' wrote on this issue is cleared: this issue is linked as the build of a workflow, so its build is its deliverable and an approved design revision is evidence for it, not its landing. The mark read: '
         || coalesce(merged_landing, 'a timestamp naming no landing (a git project)')
         || '. It is marked again when its build lands.'
    FROM design_marked_build
   WHERE noticed_by IS NOT NULL;

  UPDATE issues i
     SET merged_at = NULL, merged_landing = NULL, merged_artifacts = NULL, updated_at = now()
    FROM design_marked_build m
   WHERE i.id = m.id AND m.noticed_by IS NOT NULL;
END $$;
