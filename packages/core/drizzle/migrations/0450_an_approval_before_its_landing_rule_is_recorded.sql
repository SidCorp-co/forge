-- An approval decided before ISS-262 never ran `recordDesignLanding`
-- (packages/core/src/issues/merge-record.ts), so the issue its revision was drawn under reads unmarked
-- while its deliverable is approved, and its run parks asking a person to invent a mark. This records
-- each such approval as the decision would record it now
-- (packages/core/src/issues/design-landing.ts:markApprovedDesign), stamped at the approval's
-- decided_at, never now().
--
-- WHAT IS STAMPED. An unmarked issue (no merged_at) on which some workflow's newest approved revision
-- was drawn (`design_issue_id`), that is not linked as the build of a workflow (`workflow_builds`: a
-- build issue delivers its build, and the approval is evidence on it, never its mark — how core tells a
-- design issue from one carrying code work), and that is neither archived, `dropped` nor `closed`. The
-- approvals are replayed in decision order as `recordDesignLanding` writes them on the project's shape
-- (`source.type`): in git (`git`) the first stamps a mark naming no landing and later ones keep it;
-- outside git (`storefront`, `none`) each re-points it, so the latest names the landing
-- (`designLandingOf`). Either way the artifact is the recorded revision's (`designArtifact`), and the
-- issue gets the notice the decision would have posted (`designLandingNotice`), authored by the
-- approver and saying it was recorded late.
--
-- WHAT IS LEFT, AND LISTED BY NAME. An issue already marked — a merge Forge observed (a commit), or a
-- mark resting on somebody's word — whatever revision its approvals name; a build issue; a project that
-- declares no source type, whose shape is unknown. Each is named in a NOTICE.
--
-- WHAT IS REFUSED, BY NAME. A candidate whose project stores a source type no schema admits: whether its
-- work lands in git cannot be read, so the deploy aborts naming it.
--
-- ROLLBACK: none in SQL; every stamped issue carries the notice naming the revision, and
-- DELETE /api/issues/:id/merge unmarks one a person rules was wrong.

DO $$
DECLARE
  refused text;
  listed text;
BEGIN
  CREATE TEMP TABLE late_design_approval ON COMMIT DROP AS
  SELECT i.id, p.slug, i.iss_seq, i.merged_at, i.merged_commit_sha, i.merged_landing,
         i.status, i.archived_at,
         EXISTS (SELECT 1 FROM workflow_builds b WHERE b.issue_id = i.id) AS builds,
         pcd.document -> 'source' ->> 'type' AS source_type,
         w.flow, d.revision, d.decided_at, d.decided_by_user
    FROM project_workflow_designs d
    JOIN project_workflows w ON w.id = d.workflow_id
    JOIN issues i ON i.id = d.design_issue_id
    JOIN projects p ON p.id = i.project_id
    LEFT JOIN project_config_documents pcd ON pcd.project_id = i.project_id
   WHERE d.decision = 'approve'
     AND d.revision = (
       SELECT max(n.revision) FROM project_workflow_designs n
        WHERE n.workflow_id = d.workflow_id AND n.decision = 'approve'
     );

  SELECT string_agg(DISTINCT format('%s ISS-%s (%s): source.type `%s`', slug, iss_seq, id, source_type), '; ')
    INTO refused
    FROM late_design_approval
   WHERE merged_at IS NULL AND NOT builds AND archived_at IS NULL
     AND status NOT IN ('dropped', 'closed')
     AND source_type IS NOT NULL AND source_type NOT IN ('git', 'storefront', 'none');
  IF refused IS NOT NULL THEN
    RAISE EXCEPTION 'DESIGN_LANDING_SHAPE_UNKNOWN: % — whether this work lands in git cannot be read, so no approval can be recorded as its landing; declare source.type git, storefront or none (PUT /api/projects/:id/config), then deploy again.', refused;
  END IF;

  SELECT string_agg(DISTINCT format('%s ISS-%s (%s): %s', slug, iss_seq, id,
           CASE
             WHEN coalesce(trim(merged_commit_sha), '') <> '' THEN 'a merge Forge observed'
             WHEN coalesce(trim(merged_landing), '') = '' THEN 'a mark resting on somebody''s word'
             ELSE format('a mark naming %s', merged_landing)
           END), '; ')
    INTO listed
    FROM late_design_approval
   WHERE merged_at IS NOT NULL AND NOT builds AND archived_at IS NULL
     AND status NOT IN ('dropped', 'closed');
  IF listed IS NOT NULL THEN
    RAISE NOTICE 'ISS-262 backfill: left as marked: %', listed;
  END IF;

  SELECT string_agg(DISTINCT format('%s ISS-%s (%s): %s', slug, iss_seq, id,
           CASE WHEN builds THEN 'linked as the build of a workflow, so an approval is evidence on it'
                ELSE 'its project declares no source type' END), '; ')
    INTO listed
    FROM late_design_approval
   WHERE merged_at IS NULL AND archived_at IS NULL AND status NOT IN ('dropped', 'closed')
     AND (builds OR source_type IS NULL);
  IF listed IS NOT NULL THEN
    RAISE NOTICE 'ISS-262 backfill: left unmarked: %', listed;
  END IF;

  CREATE TEMP TABLE late_design_landing ON COMMIT DROP AS
  SELECT DISTINCT ON (id)
         id, slug, iss_seq, flow, revision, decided_at, decided_by_user,
         source_type = 'git' AS in_git
    FROM late_design_approval
   WHERE merged_at IS NULL AND NOT builds AND archived_at IS NULL
     AND status NOT IN ('dropped', 'closed')
     AND source_type IN ('git', 'storefront', 'none')
   ORDER BY id,
            CASE WHEN source_type = 'git' THEN decided_at END ASC,
            CASE WHEN source_type <> 'git' THEN decided_at END DESC,
            flow;

  UPDATE issues i
     SET merged_at = l.decided_at,
         merged_landing = CASE WHEN l.in_git THEN i.merged_landing
                               ELSE format('workflow design `%s` revision %s, approved', l.flow, l.revision) END,
         merged_artifacts = jsonb_build_array(jsonb_build_object(
           'surface', 'design', 'ref', format('%s@rev%s', l.flow, l.revision), 'change', 'changed')),
         updated_at = now()
    FROM late_design_landing l
   WHERE i.id = l.id AND i.merged_at IS NULL;

  INSERT INTO comments (issue_id, author_id, body)
  SELECT id, decided_by_user,
         format('Design `%s` revision %s was approved, and it is this issue''s deliverable, so this issue''s merged mark now records it. ', flow, revision)
         || CASE WHEN in_git
                 THEN 'This project lands its work in git, where a mark names no revision, so the mark is a timestamp and this notice names the revision. '
                 ELSE 'Its landing now names the approved revision. ' END
         || format('The approval was decided at %s, before an approval recorded its landing (ISS-262), so the mark is recorded now, stamped at that time. The approval moves no status: this issue''s run, or the release that claims it, takes its next move.',
                   to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'))
    FROM late_design_landing;

  SELECT string_agg(format('%s ISS-%s (%s): `%s` r%s at %s', slug, iss_seq, id, flow, revision, decided_at), '; ' ORDER BY slug, iss_seq)
    INTO listed
    FROM late_design_landing;
  RAISE NOTICE 'ISS-262 backfill: stamped: %', coalesce(listed, 'none');
END $$;
