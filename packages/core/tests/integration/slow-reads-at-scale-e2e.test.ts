// ISS-1070 r2: the reads the shell and the Dashboard wait on, timed at forge-dev's size. On forge-dev
// (2026-11-07, 532d8d6cd) `/needs-you/decisions` took 8.4 s over 313 queries, `/needs-you` 7 s over
// 313, and the requirement, feedback and release lists the attention read is built from 5 to 8 s each.
// This seeds one project the shape of forge on dev (88 requirements, 1100 issues with their criteria
// and verdicts, 540 releases, 500 feedback) and records each read's statements, its slowest ones and
// its wall time, and holds every statement to a ceiling of shared buffers its plan touches. Set
// SLOW_READS_OUT to a file to keep the measures, and SLOW_READS_EXPLAIN to add the slowest plans.

import { appendFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { withKernelMarker } from '../../src/db/kernel-marker.js';
import { closeWorld, type Doc, requester, testEnv } from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';

const SCALE = {
  requirements: 88,
  criteriaPerRequirement: 8,
  issues: 1100,
  criteriaPerIssue: 5,
  verdictsPerCriterion: 4,
  releases: 540,
  feedback: 500,
  activityPerIssue: 20,
};

let ownerId: string;
let token: string;
let projectId: string;
let app: Awaited<typeof import('../../src/index.js')>['app'];

const SHA = 'a'.repeat(40);

async function seed(): Promise<void> {
  projectId = (await createTestProject(ownerId)).id;
  const p = projectId;
  const s = SCALE;
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
  await db.execute(sql`ANALYZE`);
}

interface Statement {
  text: string;
  params: unknown;
  ms: number;
}

interface Measure {
  path: string;
  status: number;
  ms: number;
  statements: Statement[];
  body: Doc;
}

type Unsafe = (
  ...args: unknown[]
) => PromiseLike<unknown> & { handle: () => unknown; executed?: boolean };

/** One GET, with every statement it sent and how long each took from send to answer. */
async function measured(path: string): Promise<Measure> {
  const client = (db as unknown as { $client: { unsafe: Unsafe } }).$client;
  const statements: Statement[] = [];
  const unsafe = client.unsafe;
  client.unsafe = (...args: unknown[]) => {
    const query = unsafe(...args);
    const handle = query.handle;
    query.handle = function (this: typeof query) {
      if (!this.executed) {
        const started = performance.now();
        const done = () =>
          statements.push({
            text: String(args[0]),
            params: args[1],
            ms: performance.now() - started,
          });
        Promise.prototype.then.call(this, done, done);
      }
      return handle.call(this);
    };
    return query;
  };
  try {
    const started = performance.now();
    const reply = await requester(app, { owner: token })('owner', 'GET', path);
    return {
      path,
      status: reply.status,
      ms: performance.now() - started,
      statements,
      body: reply.json,
    };
  } finally {
    client.unsafe = unsafe;
  }
}

/** `EXPLAIN (ANALYZE, BUFFERS)` of a statement a read sent, its plan's top lines and its execution time. */
async function explained(s: Statement): Promise<string> {
  const client = (
    db as unknown as {
      $client: { unsafe: (t: string, p?: unknown) => Promise<{ 'QUERY PLAN': string }[]> };
    }
  ).$client;
  try {
    const plan = await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${s.text}`, s.params);
    const lines = plan.map((r) => r['QUERY PLAN']);
    return [
      ...lines.slice(0, Number(process.env.SLOW_READS_PLAN_LINES ?? 6)),
      ...lines.filter((l) => /Execution Time|Planning Time/.test(l)),
    ]
      .map((l) => `      | ${l.slice(0, 200)}`)
      .join('\n');
  } catch (err) {
    return `      | (no plan: ${(err as Error).message})`;
  }
}

/**
 * The most shared buffers one statement of these reads may touch at this size. Time on a laptop or
 * a CI box varies; the pages a plan reads do not. Before ISS-1070 r2 the shipped-release read
 * touched 1.36 million (each issue detoasting every release's metadata); the heaviest statement
 * after it, the requirement verdict read, about 35 thousand.
 */
const BUFFERS_PER_STATEMENT = 200_000;

/** The shared buffers a read-only statement's plan touches, children and subplans included. */
async function buffersOf(s: Statement): Promise<number | null> {
  if (!/^\s*(SELECT|WITH)\b/i.test(s.text) || /\b(INSERT|UPDATE|DELETE)\b/i.test(s.text))
    return null;
  const client = (
    db as unknown as {
      $client: { unsafe: (t: string, p?: unknown) => Promise<{ 'QUERY PLAN': unknown }[]> };
    }
  ).$client;
  const [row] = await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${s.text}`, s.params);
  const [top] = (row?.['QUERY PLAN'] ?? []) as { Plan: Record<string, number> }[];
  return (top?.Plan['Shared Hit Blocks'] ?? 0) + (top?.Plan['Shared Read Blocks'] ?? 0);
}

function report(label: string, m: Measure): string {
  const slowest = [...m.statements].sort((a, b) => b.ms - a.ms).slice(0, 8);
  const same = new Map<string, number>();
  for (const s of m.statements) same.set(s.text, (same.get(s.text) ?? 0) + 1);
  const repeated = [...same].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  return [
    `## ${label} ${m.path} -> ${m.status}: ${m.ms.toFixed(0)} ms, ${m.statements.length} statements, ${repeated.reduce((n, [, c]) => n + c - 1, 0)} repeats`,
    ...slowest.map(
      (s) => `  ${s.ms.toFixed(1).padStart(8)} ms  ${s.text.replace(/\s+/g, ' ').slice(0, 260)}`,
    ),
    ...repeated.slice(0, 5).map(([t, n]) => `  x${n} ${t.replace(/\s+/g, ' ').slice(0, 200)}`),
  ].join('\n');
}

const READS = (p: string) => [
  `/api/projects/${p}/needs-you`,
  `/api/projects/${p}/needs-you/decisions`,
  `/api/projects/${p}/releases/shipped?limit=3`,
  '/api/me/attention',
  '/api/me/home',
];

beforeAll(async () => {
  testEnv();
  ({ app } = await import('../../src/index.js'));
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  token = await signUserToken(ownerId);
  await seed();
}, 300_000);

afterAll(closeWorld);

describe('the shell and Dashboard reads at forge-dev size', () => {
  it('answers each read, each statement within its buffer ceiling, and records its statements and time', async () => {
    const out = process.env.SLOW_READS_OUT;
    for (const path of READS(projectId)) {
      const warm = await measured(path); // the first request pays for the prepared statements
      expect(warm.status, `${path}: ${JSON.stringify(warm.body).slice(0, 400)}`).toBe(200);
      const runs = [await measured(path), await measured(path), await measured(path)];
      const median = [...runs].sort((a, b) => a.ms - b.ms)[1] as Measure;
      const plans = process.env.SLOW_READS_EXPLAIN
        ? await Promise.all(
            [...median.statements]
              .sort((a, b) => b.ms - a.ms)
              .slice(0, 3)
              .map(
                async (s) =>
                  `    plan of ${s.text.replace(/\s+/g, ' ').slice(0, 120)}\n${await explained(s)}`,
              ),
          )
        : [];
      const line = [
        report(`median of 3 (${runs.map((r) => r.ms.toFixed(0)).join(', ')})`, median),
        ...plans,
      ].join('\n');
      if (out) appendFileSync(out, `${line}\n`);
      // each statement's plan stays within the ceiling: no read pays once per row for what one read answers
      for (const s of median.statements) {
        const buffers = await buffersOf(s);
        expect(
          buffers ?? 0,
          `${path} sent a statement touching ${buffers} buffers: ${s.text.replace(/\s+/g, ' ').slice(0, 300)}`,
        ).toBeLessThanOrEqual(BUFFERS_PER_STATEMENT);
      }
    }
  }, 600_000);
});
