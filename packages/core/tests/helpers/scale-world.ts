// One project the shape of forge on forge-dev, at a size the caller names, in an org the caller may name: requirements with agreed
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
  /** How many of the newest issues are not closed, spread over the open statuses; 80 where unnamed. */
  open?: number;
  /**
   * The shape forge has on forge-dev (2026-11-08) where the plain seed is uniform: verdicts judged at
   * the commit of the release that carried their issue, a runtime serving it, or a commit no release
   * names, rather than all at one; requirements accepted and dropped beside agreed; feedback answered,
   * duplicated and routed to a new requirement beside the issue route, most of it reported by agents;
   * approved workflow designs (25 for forge's size) with their revisions, the requirements they
   * serve and the issues building them.
   */
  live?: boolean;
  /**
   * Requirements over every state a project's hold, as forge-dev's projects hold them (ISS-1070 r10):
   * one in six each draft (a proposed first revision, no baseline), agreed, in delivery, delivered,
   * accepted and dropped; half revised once, the revision retiring a criterion and adding one, a
   * fifth carrying an open proposal; each status reached through the kernel. Where the plain seed
   * held every requirement agreed at one revision, a read that asks once per requirement or per
   * state looked flat.
   */
  states?: boolean;
  /**
   * How many of the newest releases are recorded landings on a branch, as catalog-api and adminhub-api
   * record theirs (ISS-1070 r10): their project declares no production, so each stays `landed`, a
   * release that can still wait on someone, and Needs you weighs every one. With every release
   * shipped, a read once per release in play looked flat.
   */
  batches?: number;
}

const SHA = 'a'.repeat(40);

/** Seeds the project and answers its id; the newest release's commit is `servingCommit`, where named. */
export async function seedAtScale(
  ownerId: string,
  s: Scale,
  opts: { projectId?: string; servingCommit?: string; orgId?: string } = {},
): Promise<string> {
  const p = (
    await createTestProject(ownerId, {
      ...(opts.projectId ? { id: opts.projectId } : {}),
      ...(opts.orgId ? { orgId: opts.orgId } : {}),
    })
  ).id;
  const closed = s.issues - (s.open ?? 80);
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`
      INSERT INTO requirements (id, project_id, req_seq, title, status)
      SELECT gen_random_uuid(), ${p}, g, 'requirement ' || g, 'draft' FROM generate_series(1, ${s.requirements}) g`);
    await tx.execute(sql`
      INSERT INTO requirement_revisions (requirement_id, revision, state, spec, reason, author_id, author_agency, decided_by, decided_at, proposed_by, proposed_at)
      SELECT id, 1, CASE WHEN draft THEN 'proposed' ELSE 'current' END, '{}'::jsonb, 'first cut', ${ownerId}, 'human',
             CASE WHEN NOT draft THEN ${ownerId}::uuid END, CASE WHEN NOT draft THEN now() END,
             CASE WHEN draft THEN ${ownerId}::uuid END, CASE WHEN draft THEN now() END
        FROM (SELECT id, ${s.states === true} AND req_seq % 6 = 0 AS draft FROM requirements WHERE project_id = ${p}) r`);
    // a {@link Scale.states} draft stays a draft, its first revision proposed
    await tx.execute(
      sql`UPDATE requirements SET current_revision = 1, status = 'agreed'
           WHERE project_id = ${p} AND NOT (${s.states === true} AND req_seq % 6 = 0)`,
    );
    // each agreed requirement holds the baseline its agree wrote; one {@link Scale.states} keeps a draft holds none
    await tx.execute(sql`
      INSERT INTO requirement_baselines (requirement_id, revision, seq, act, agreed_by, agreed_kind)
      SELECT id, 1, 1, 'agree', ${ownerId}, 'person' FROM requirements
       WHERE project_id = ${p} AND NOT (${s.states === true} AND req_seq % 6 = 0)`);
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
           CASE WHEN g <= ${closed} THEN 'closed'
                ELSE (ARRAY['open','in_progress','awaiting_release','draft','dropped'])[1 + g % 5] END,
           ${ownerId}, now() - make_interval(hours => ${s.issues} - g),
           CASE WHEN g <= ${closed} THEN now() - make_interval(hours => ${s.issues} - g) END,
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
  if (s.live) await liveShape(p, s);
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
  if (s.batches) await recordedLandings(p, s.batches);
  if (s.live) await liveFeedback(p, s);
  if (s.live) await liveWorkflows(p, ownerId, s);
  if (s.states) await requirementStates(p, ownerId);
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
     WHERE i.project_id = ${p} AND i.iss_seq > ${closed}`);
  await db.execute(sql`
    INSERT INTO issue_dependencies (project_id, from_issue_id, to_issue_id, kind)
    SELECT ${p}, b.id, t.id, 'blocks' FROM issues b JOIN issues t ON t.project_id = b.project_id AND t.iss_seq = b.iss_seq + 7
     WHERE b.project_id = ${p} AND b.iss_seq > ${closed} AND b.iss_seq % 3 = 0`);
  await db.execute(sql`
    INSERT INTO release_holds (project_id, issue_id, code, reason, owes, waiting_for)
    SELECT ${p}, id, 'RELEASE_CRITERIA_UNEARNED', 'no runtime witnessed it', 'human', 'a verdict at the running deployment'
      FROM issues WHERE project_id = ${p} AND status = 'awaiting_release' AND iss_seq % 2 = 0`);
  await db.execute(sql`ANALYZE`);
  return p;
}

/** The release commit the plain seed gives release `g` (each carries issues 2g-1 and 2g). */
const releaseCommit = (g: ReturnType<typeof sql>) => sql`rpad(md5((${g})::text), 40, '0')`;

/** {@link Scale.live}: the identities, statuses and routes forge holds on forge-dev, over the plain seed's rows. */
async function liveShape(p: string, s: Scale): Promise<void> {
  // a verdict names its issue's release commit, one in four the runtime serving it, one in seven a
  // commit no release names; the last verdict of each criterion keeps its own
  await db.execute(sql`
    UPDATE criterion_verdicts v SET
      identity_kind = CASE WHEN i.iss_seq % 4 = 0 THEN 'runtime' ELSE 'commit' END,
      commit_sha = CASE WHEN i.iss_seq % 4 = 0 THEN NULL
                        WHEN i.iss_seq % 7 = 0 THEN md5('unplaced' || i.iss_seq) || '00000000'
                        ELSE ${releaseCommit(sql`(i.iss_seq + 1) / 2`)} END,
      runtime_ref = CASE WHEN i.iss_seq % 4 = 0 THEN ${releaseCommit(sql`(i.iss_seq + 1) / 2`)} END
      FROM issues i WHERE i.id = v.issue_id AND i.project_id = ${p} AND i.iss_seq <= ${2 * s.releases}`);
  // {@link Scale.states} spreads them over every state in its own place
  if (s.states) return;
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`
      UPDATE requirements SET status = CASE WHEN req_seq % 4 = 0 THEN 'dropped' ELSE 'accepted' END
       WHERE project_id = ${p} AND req_seq % 3 = 0`);
  });
}

/** {@link Scale.live}: the untriaged half answered, duplicated, routed to a new requirement or declined. */
async function liveFeedback(p: string, s: Scale): Promise<void> {
  await withKernelMarker(db, async (tx) => {
    // the untriaged half answered, duplicated, routed to a new requirement or declined, as on forge
    await tx.execute(sql`
      UPDATE feedback f SET status = CASE WHEN f.fb_seq % 10 = 9 THEN 'declined' ELSE 'triaged' END,
             route = (ARRAY['answer', 'duplicate', 'new_requirement', NULL, NULL])[1 + (f.fb_seq / 2) % 5],
             answer = CASE WHEN (f.fb_seq / 2) % 5 = 0 THEN 'answered' END,
             duplicate_of = CASE WHEN (f.fb_seq / 2) % 5 = 1
               THEN (SELECT d.id FROM feedback d WHERE d.project_id = f.project_id AND d.fb_seq = f.fb_seq - 1) END,
             routed_requirement_id = CASE WHEN (f.fb_seq / 2) % 5 = 2
               THEN (SELECT r.id FROM requirements r WHERE r.project_id = f.project_id AND r.req_seq = 1 + f.fb_seq % ${s.requirements}) END,
             reporter_agency = CASE WHEN f.fb_seq % 5 = 0 THEN 'human' ELSE 'agent' END
       WHERE f.project_id = ${p} AND f.fb_seq % 2 = 1 AND f.fb_seq > 1`);
    await tx.execute(
      sql`UPDATE feedback SET status = 'verified' WHERE project_id = ${p} AND route = 'issue' AND fb_seq % 4 = 0`,
    );
  });
}

/**
 * {@link Scale.live}: approved workflow designs, one per four requirements, each at a revision up to
 * twenty with every revision approved, serving its requirements and built by four closed issues.
 */
async function liveWorkflows(p: string, ownerId: string, s: Scale): Promise<void> {
  const { readFileSync } = await import('node:fs');
  const doc = JSON.parse(
    readFileSync(
      new URL('../fixtures/workflows/post-discharge.design.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
  const count = Math.max(1, Math.round(s.requirements / 4));
  await withKernelMarker(db, async (tx) => {
    await tx.execute(sql`
      INSERT INTO project_workflows (project_id, flow, kind, revision, document, design_status, approved_revision, written_by_user)
      SELECT ${p}, 'flow-' || g, 'flow', 1 + g % 20,
             ${JSON.stringify(doc)}::jsonb || jsonb_build_object('project', ${p}::text, 'flow', 'flow-' || g),
             'approved', 1 + g % 20, ${ownerId}
        FROM generate_series(1, ${count}) g`);
    await tx.execute(sql`
      INSERT INTO project_workflow_designs (workflow_id, revision, document, proposed_by_user, decision, decided_by_user, decided_kind, decided_at)
      SELECT w.id, r, w.document, ${ownerId}, 'approve', ${ownerId}, 'person', now() - make_interval(hours => w.revision - r)
        FROM project_workflows w CROSS JOIN LATERAL generate_series(1, w.revision) r
       WHERE w.project_id = ${p}`);
    await tx.execute(sql`
      INSERT INTO requirement_workflows (requirement_id, workflow_id, linked_by)
      SELECT r.id, w.id, ${ownerId} FROM project_workflows w
        JOIN requirements r ON r.project_id = w.project_id
         AND r.req_seq % ${count} = substr(w.flow, 6)::int % ${count}
       WHERE w.project_id = ${p}`);
    await tx.execute(sql`
      INSERT INTO workflow_builds (issue_id, workflow_id, project_id, linked_by_user, step_ids)
      SELECT i.id, w.id, ${p}, ${ownerId}, ARRAY[w.document->'steps'->0->>'id']
        FROM project_workflows w
        JOIN issues i ON i.project_id = w.project_id AND i.status = 'closed'
         AND i.iss_seq % ${count} = substr(w.flow, 6)::int % ${count} AND i.iss_seq <= ${4 * count}
       WHERE w.project_id = ${p}`);
  });
}

/** {@link Scale.states}: the plain seed's agreed requirements spread over every state, revised and proposed. */
async function requirementStates(p: string, ownerId: string): Promise<void> {
  await withKernelMarker(db, async (tx) => {
    // half revised once: the first revision superseded, the second current, a criterion retired and one added
    await tx.execute(sql`
      UPDATE requirement_revisions v SET state = 'superseded' FROM requirements r
       WHERE r.id = v.requirement_id AND r.project_id = ${p} AND r.req_seq % 2 = 0 AND r.req_seq % 6 <> 0 AND v.revision = 1`);
    await tx.execute(sql`
      INSERT INTO requirement_revisions (requirement_id, revision, state, base_revision, spec, reason, author_id, author_agency, decided_by, decided_at)
      SELECT id, 2, 'current', 1, '{}'::jsonb, 'revised', ${ownerId}, 'agent', ${ownerId}, now()
        FROM requirements WHERE project_id = ${p} AND req_seq % 2 = 0 AND req_seq % 6 <> 0`);
    await tx.execute(sql`
      UPDATE requirements SET current_revision = 2 WHERE project_id = ${p} AND req_seq % 2 = 0 AND req_seq % 6 <> 0`);
    await tx.execute(sql`
      UPDATE requirement_criteria c SET retired_revision = 2 FROM requirements r
       WHERE r.id = c.requirement_id AND r.project_id = ${p} AND r.req_seq % 2 = 0 AND r.req_seq % 6 <> 0 AND c.code = 'BC-1'`);
    await tx.execute(sql`
      INSERT INTO requirement_criteria (requirement_id, code, body, since_revision)
      SELECT id, 'BC-90', 'it holds since the revision', 2 FROM requirements
       WHERE project_id = ${p} AND req_seq % 2 = 0 AND req_seq % 6 <> 0`);
    await tx.execute(sql`
      INSERT INTO requirement_baselines (requirement_id, revision, seq, act, agreed_by, agreed_kind)
      SELECT id, 2, 1, 'agree', ${ownerId}, 'person' FROM requirements
       WHERE project_id = ${p} AND req_seq % 2 = 0 AND req_seq % 6 <> 0`);
    // a fifth carry an open proposal beside the revision that stands
    await tx.execute(sql`
      INSERT INTO requirement_revisions (requirement_id, revision, state, base_revision, spec, reason, author_id, author_agency, proposed_by, proposed_at)
      SELECT id, current_revision + 1, 'proposed', current_revision, '{}'::jsonb, 'a change asked', ${ownerId}, 'agent', ${ownerId}, now()
        FROM requirements WHERE project_id = ${p} AND req_seq % 5 = 0 AND req_seq % 6 <> 0`);
    // one in six of each state; a draft was seeded with its first revision proposed and no baseline
    await tx.execute(sql`
      UPDATE requirements SET
        status = (ARRAY['agreed', 'in_delivery', 'delivered', 'accepted', 'dropped'])[req_seq % 6],
        accepted_at = CASE WHEN req_seq % 6 = 4 THEN now() END
       WHERE project_id = ${p} AND req_seq % 6 <> 0`);
    // each status reached through the kernel, the path every requirement walked to it
    await tx.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source, created_at)
      SELECT 'requirement', r.id, m.f, m.t, 'user', 'human', ${ownerId}, 'test', r.created_at + make_interval(mins => m.n)
        FROM requirements r CROSS JOIN (VALUES (1, 'draft', 'agreed', 1), (2, 'agreed', 'in_delivery', 2),
                                               (3, 'in_delivery', 'delivered', 3), (4, 'delivered', 'accepted', 4)) AS m(n, f, t, upto)
       WHERE r.project_id = ${p} AND r.req_seq % 6 > 0 AND m.upto <= least(r.req_seq % 6, 4)`);
    await tx.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, actor_id, source, reason, created_at)
      SELECT 'requirement', r.id, 'agreed', 'dropped', 'user', 'human', ${ownerId}, 'test', 'no longer wanted', r.created_at + make_interval(mins => 9)
        FROM requirements r WHERE r.project_id = ${p} AND r.req_seq % 6 = 5`);
  });
}

/** {@link Scale.batches}: the newest `n` releases recorded as landings on `release/stg`, each with its attempt. */
async function recordedLandings(p: string, n: number): Promise<void> {
  await db.execute(sql`
    UPDATE pipeline_runs SET metadata = metadata || jsonb_build_object(
             'source', 'release-record', 'gateStatus', 'awaiting_release', 'verification', 'landed',
             'branch', 'release/stg', 'identity', metadata->'finish'->'commit', 'commit', metadata->'finish'->'commit',
             'recordedBy', null)
     WHERE id IN (SELECT id FROM pipeline_runs WHERE project_id = ${p} AND release_version IS NOT NULL
                   ORDER BY release_released_at DESC LIMIT ${n})`);
  await db.execute(sql`
    INSERT INTO release_attempts (run_id, stage, idempotency_key, commit, identity, verdict, verdict_reason, started_at, settled_at)
    SELECT id, 'deploy', 'record:' || id, metadata->>'commit', metadata->>'commit', 'recorded', 'landed on release/stg',
           release_released_at, release_released_at
      FROM pipeline_runs WHERE project_id = ${p} AND metadata->>'source' = 'release-record'`);
}
