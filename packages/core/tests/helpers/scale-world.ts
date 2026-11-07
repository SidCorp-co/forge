// One project the shape of forge on forge-dev, at a size the caller names: requirements with agreed
// revisions and criteria, issues mostly closed and released with their criteria, verdicts, moves and
// activity, releases carrying them, feedback routed onto them, and the open issues' modules, blocks
// edges and release holds (ISS-1070). The reads the shell and the Dashboard wait on are timed over it
// (`slow-reads-at-scale-e2e.test.ts`) and compared inside and outside one request
// (`needs-you-reads-in-play-e2e.test.ts`).

import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { createTestProject } from './factories.js';

export interface Scale {
  requirements: number;
  criteriaPerRequirement: number;
  issues: number;
  criteriaPerIssue: number;
  verdictsPerCriterion: number;
  releases: number;
  feedback: number;
  activityPerIssue: number;
}

const SHA = 'a'.repeat(40);

/** Seeds the project and answers its id; the newest release's commit is `servingCommit`, where named. */
export async function seedAtScale(
  ownerId: string,
  s: Scale,
  opts: { projectId?: string; servingCommit?: string } = {},
): Promise<string> {
  const p = (await createTestProject(ownerId, opts.projectId ? { id: opts.projectId } : {})).id;
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`
      INSERT INTO requirements (id, project_id, req_seq, title, status)
      SELECT gen_random_uuid(), ${p}, g, 'requirement ' || g, 'draft' FROM generate_series(1, ${s.requirements}) g`);
    await tx.execute(sql`
      INSERT INTO requirement_revisions (requirement_id, revision, state, spec, reason, author_id, author_agency, decided_by, decided_at)
      SELECT id, 1, 'current', '{}'::jsonb, 'first cut', ${ownerId}, 'human', ${ownerId}, now()
        FROM requirements WHERE project_id = ${p}`);
    await tx.execute(
      sql`UPDATE requirements SET current_revision = 1, status = 'agreed' WHERE project_id = ${p}`,
    );
    // each agreed requirement holds the baseline its agree wrote
    await tx.execute(sql`
      INSERT INTO requirement_baselines (requirement_id, revision, seq, act, agreed_by, agreed_kind)
      SELECT id, 1, 1, 'agree', ${ownerId}, 'person' FROM requirements WHERE project_id = ${p}`);
  });
  await db.execute(sql`
    INSERT INTO requirement_criteria (requirement_id, code, body, since_revision)
    SELECT r.id, 'BC-' || g, 'it holds ' || g, 1
      FROM requirements r CROSS JOIN generate_series(1, ${s.criteriaPerRequirement}) g
     WHERE r.project_id = ${p}`);
  // most issues closed and released, the rest spread over the open statuses
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, created_at, merged_at, priority, requirement_id, planned_revision)
    SELECT gen_random_uuid(), ${p}, g, 'issue ' || g,
           CASE WHEN g <= ${s.issues - 80} THEN 'closed'
                ELSE (ARRAY['open','in_progress','awaiting_release','draft','dropped'])[1 + g % 5] END,
           ${ownerId}, now() - make_interval(hours => ${s.issues} - g),
           CASE WHEN g <= ${s.issues - 80} THEN now() - make_interval(hours => ${s.issues} - g) END,
           'medium',
           (SELECT id FROM requirements WHERE project_id = ${p} AND req_seq = 1 + g % ${s.requirements}),
           1
      FROM generate_series(1, ${s.issues}) g`);
  await db.execute(sql`
    INSERT INTO issue_criteria (issue_id, n, statement, position, requirement_criterion_id)
    SELECT i.id, g, 'criterion ' || g, g,
           (SELECT c.id FROM requirement_criteria c WHERE c.requirement_id = i.requirement_id AND c.code = 'BC-' || g)
      FROM issues i CROSS JOIN generate_series(1, ${s.criteriaPerIssue}) g
     WHERE i.project_id = ${p}`);
  await db.execute(sql`
    INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, author_agency, identity_kind, commit_sha, reason, created_at)
    SELECT c.id, c.issue_id, CASE WHEN v = ${s.verdictsPerCriterion} THEN 'pass' ELSE 'fail' END, 'agent', 'commit', ${SHA},
           'judged', now() - make_interval(mins => 10 - v)
      FROM issue_criteria c JOIN issues i ON i.id = c.issue_id CROSS JOIN generate_series(1, ${s.verdictsPerCriterion}) v
     WHERE i.project_id = ${p}`);
  await db.execute(sql`
    INSERT INTO pipeline_runs (project_id, issue_id, kind, status, started_at, finished_at, metadata)
    SELECT ${p}, i.id, 'issue', 'completed', i.created_at, i.created_at, '{}'::jsonb
      FROM issues i CROSS JOIN generate_series(1, 2) WHERE i.project_id = ${p}`);
  // each release carries two of the closed issues, newest last
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, finished_at, release_version, release_released_at, metadata)
    SELECT gen_random_uuid(), ${p}, 'system', 'completed',
           now() - make_interval(hours => ${s.releases} - g), now() - make_interval(hours => ${s.releases} - g),
           '0.4.0-dev.' || g, now() - make_interval(hours => ${s.releases} - g),
           jsonb_build_object('issueIds', (SELECT jsonb_agg(id) FROM issues WHERE project_id = ${p} AND iss_seq IN (2 * g - 1, 2 * g)),
                              'source', 'release-batch',
                              'finish', jsonb_build_object('state', 'finished',
                                'commit', CASE WHEN g = ${s.releases} THEN ${opts.servingCommit ?? null}::text ELSE rpad(md5(g::text), 40, '0') END),
                              'notes', (SELECT string_agg(md5(g::text || n::text), ' ') FROM generate_series(1, 120) n))
      FROM generate_series(1, ${s.releases}) g`);
  await db.transaction(async (tx) => {
    await tx.execute(sql`
    INSERT INTO feedback (id, project_id, fb_seq, kind, title, where_seen, status, route, reported_by, reporter_agency)
    SELECT gen_random_uuid(), ${p}, g, 'bug', 'feedback ' || g, 'The board',
           CASE WHEN g % 2 = 0 THEN 'triaged' ELSE 'new' END, CASE WHEN g % 2 = 0 THEN 'issue' END, ${ownerId}, 'human'
      FROM generate_series(1, ${s.feedback}) g`);
    await tx.execute(sql`
    INSERT INTO feedback_route_issues (feedback_id, issue_id)
    SELECT f.id, (SELECT id FROM issues WHERE project_id = ${p} AND iss_seq = f.fb_seq)
      FROM feedback f WHERE f.project_id = ${p} AND f.route = 'issue'`);
  });
  await db.execute(sql`
    INSERT INTO activity_log (issue_id, actor_type, actor_id, actor_agency, action, payload, created_at)
    SELECT i.id, 'user', ${ownerId}, 'human', 'issue.statusChanged',
           jsonb_build_object('from', 'open', 'to', 'in_progress'), i.created_at + make_interval(mins => g)
      FROM issues i CROSS JOIN generate_series(1, ${s.activityPerIssue}) g WHERE i.project_id = ${p}`);
  // each issue's moves through the kernel, one in ten reopened after it closed
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source, created_at)
      SELECT 'issue', i.id, m.f, m.t, 'user', 'human', ${ownerId}, 'test', i.created_at + make_interval(mins => m.n)
        FROM issues i CROSS JOIN (VALUES (1, NULL, 'draft'), (2, 'draft', 'open'), (3, 'open', 'in_progress'),
                                          (4, 'in_progress', 'awaiting_release'), (5, 'awaiting_release', 'closed')) AS m(n, f, t)
       WHERE i.project_id = ${p}`);
    await tx.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source, created_at)
      SELECT 'issue', i.id, m.f, m.t, 'user', 'human', ${ownerId}, 'test', i.created_at + make_interval(mins => 5 + m.n)
        FROM issues i CROSS JOIN (VALUES (1, 'closed', 'reopen'), (2, 'reopen', 'in_progress'),
                                          (3, 'in_progress', 'awaiting_release'), (4, 'awaiting_release', 'closed')) AS m(n, f, t)
       WHERE i.project_id = ${p} AND i.iss_seq % 10 = 0`);
  });
  // the open issues' modules, a chain of blocks edges among them, and holds on those at the gate:
  // the facts the issue standing reads per issue, from either read of them a request makes
  await db.execute(sql`
    INSERT INTO labels (project_id, name, color, kind, slug)
    SELECT ${p}, 'module ' || g, '#888888', 'module', 'module-' || g FROM generate_series(1, 6) g`);
  await db.execute(sql`
    INSERT INTO issue_labels (issue_id, label_id, is_primary)
    SELECT i.id, l.id, true FROM issues i
      JOIN labels l ON l.project_id = i.project_id AND l.slug = 'module-' || (1 + i.iss_seq % 6)
     WHERE i.project_id = ${p} AND i.iss_seq > ${s.issues - 80}`);
  await db.execute(sql`
    INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind)
    SELECT ${p}, b.id, t.id, 'blocks' FROM issues b JOIN issues t ON t.project_id = b.project_id AND t.iss_seq = b.iss_seq + 7
     WHERE b.project_id = ${p} AND b.iss_seq > ${s.issues - 80} AND b.iss_seq % 3 = 0`);
  await db.execute(sql`
    INSERT INTO release_holds (project_id, issue_id, code, reason, owes, waiting_for)
    SELECT ${p}, id, 'RELEASE_CRITERIA_UNEARNED', 'no runtime witnessed it', 'human', 'a verdict at the running deployment'
      FROM issues WHERE project_id = ${p} AND status = 'awaiting_release' AND iss_seq % 2 = 0`);
  await db.execute(sql`ANALYZE`);
  return p;
}
