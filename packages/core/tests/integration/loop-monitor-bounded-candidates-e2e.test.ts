/**
 * ISS-1013 — the result hop and its alarm read each history table per live
 * job, and they still pick the same jobs.
 *
 * Two questions, and they need different evidence. Whether the rewrite is
 * CHEAPER is a question about a plan, and a plan is a function of the fixture
 * rather than of the query — so the fixture's shape is asserted first, and each
 * bound is labelled MEASURED or CHOSEN rather than described as "production
 * like". Whether the rewrite is CORRECT is a question about which rows come
 * back, and that one is answered by running the old CTE text and the new query
 * side by side over the same rows: a bound that changes the answer is a wedged
 * job that stops being reaped with nothing going red, which is the failure this
 * whole file exists to catch.
 *
 * The criteria this file answers asked for a job with a NULL `pipeline_run_id`.
 * There is no such job and there cannot be — the column is NOT NULL — so the
 * case planted instead is a run carrying no phase rows, which reaches the same
 * branch through a shape the schema can hold. Corrected on the issue rather
 * than dropped.
 *
 * What is NOT measured here: the deployment's own statistics. The read-only
 * Postgres credential is not reachable from a run, and an 11 GB table is not
 * copyable into a test. The bounds below make the query's job HARDER than the
 * deployment does, which is the strongest thing available — it is not the same
 * as having planned against the deployment's bloat, cache and visibility map.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/** MEASURED — the filing recorded 3.9 million rows and 11 GB on beta, 2026-09-15. */
const EVENT_ROWS = 1_200_000;
/**
 * CHOSEN, not measured. `GET /api/projects/health` reported 7 concurrent runs
 * across 36 projects on 2026-09-15, which bounds RUNS and not jobs, so this is
 * set well above any reading of it. A larger outer set is the harder case: it
 * is what could push the planner off a nested loop and onto a hash join over
 * the whole of `job_events`, which is the plan this change exists to remove.
 */
const LIVE_JOBS = 48;
/** CHOSEN — a long tail is what makes `(job_id, seq)` the wrong index for `max(ts)`. */
const BUSIEST_JOB_EVENTS = 4_000;
/** CHOSEN — the driver declares nine phases and `phase_journal` is unique on (run, phase, attempt). */
const PHASES_PER_RUN = 12;
/** Terminal jobs carrying the bulk of the history, as a real deployment's do. */
const ARCHIVE_JOBS = 600;

/**
 * The query this change replaced, kept verbatim as the control. Criterion 9 is
 * an equality between two texts, so one of them has to be the OLD one — a test
 * that only asserts what the new query returns cannot tell a preserved answer
 * from a changed one.
 */
const REPLACED_CTE_QUERY = (projectId: string, quietMinutes: number) => sql`
  WITH last_event AS (
    SELECT job_id, MAX(ts) AS max_ts
    FROM job_events
    GROUP BY job_id
  ), last_phase AS (
    SELECT run_id, MAX(GREATEST(started_at, COALESCE(ended_at, started_at))) AS max_ts
    FROM phase_journal GROUP BY run_id
  )
  SELECT j.id
  FROM jobs j
  LEFT JOIN last_event le ON le.job_id = j.id
  LEFT JOIN last_phase lp ON lp.run_id = j.pipeline_run_id
  LEFT JOIN agent_sessions s ON s.id = j.agent_session_id
  WHERE j.status IN ('dispatched', 'running')
    AND (s.runtime_state IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM job_events WHERE job_id = j.id AND kind = 'result'))
    AND s.runtime_state IS DISTINCT FROM 'awaiting_input'
    AND GREATEST(COALESCE(le.max_ts, j.dispatched_at), COALESCE(lp.max_ts, j.dispatched_at),
                 j.dispatched_at) < now() - interval '${sql.raw(String(quietMinutes))} minutes'
    AND j.project_id = ${projectId}
`;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Recheck Cond'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

/**
 * What a node says about how it found its rows, whichever shape it took. A
 * Bitmap Heap Scan is the node that names the relation and it carries `Recheck
 * Cond`, while the `Index Cond` sits on its Bitmap Index Scan child, which names
 * no relation at all — so reading only `Index Cond` off relation-named nodes
 * reports a perfectly bounded bitmap scan as unbounded.
 */
function boundBy(node: PlanNode): string {
  return node['Index Cond'] ?? node['Recheck Cond'] ?? '';
}

/**
 * The live jobs. The first six are the equality cases criterion 9 names, each
 * a way the CTE and the lateral could disagree; the rest are bulk, so the
 * outer set is the size a planner would actually be given.
 */
async function seedLiveJobs(
  db: TestDatabase['db'],
  projectId: string,
  ownerId: string,
): Promise<void> {
  for (let i = 0; i < LIVE_JOBS; i++) {
    const runId = randomUUID();
    const jobId = randomUUID();
    const sessionId = randomUUID();
    // cm:guard there is no NULL-`pipeline_run_id` case to plant and there cannot be: the column is NOT NULL on both `jobs` and `agent_sessions`, so the NULL the CTE's outer join produced for a job with no run is unreachable in this schema. The representable case that exercises the same branch is a run carrying NO phase rows — the CTE's `last_phase` has no row for it, the lateral's aggregate returns NULL, and both must fall back to `dispatched_at`. Case 2 below is that, with events present, so the empty phase side is tested against a non-empty event side rather than against another empty one.
    const parked = i === 4;
    const resident = i === 5;

    await db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, 'pm', 'running', now() - interval '4 hours')
    `);
    await db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, metadata,
                                  started_at, last_heartbeat_at, runtime_state,
                                  created_at, updated_at)
      VALUES (${sessionId}, ${projectId}, ${runId}, 'running',
              ${JSON.stringify({ type: 'pipeline' })}::jsonb,
              now() - interval '4 hours', now() - interval '4 hours',
              ${parked ? 'awaiting_input' : resident ? 'working' : null},
              now() - interval '4 hours', now() - interval '4 hours')
    `);
    await db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, agent_session_id, created_by,
                        type, status, queued_at, dispatched_at)
      VALUES (${jobId}, ${projectId}, ${runId}, ${sessionId}, ${ownerId},
              'drive', 'running', now() - interval '4 hours', now() - interval '4 hours')
    `);

    // case 1 (i === 0): no events and no phases at all.
    // case 2 (i === 1): events but NO phase rows on its run — see the guard above.
    if (i === 2) {
      // case 3: the run carries ONE started phase that never ended. The
      // lateral's COALESCE(ended_at, started_at) is what has to see it.
      await db.execute(sql`
        INSERT INTO phase_journal (id, project_id, run_id, phase, attempt, source, started_at)
        VALUES (${randomUUID()}, ${projectId}, ${runId}, 'phase-4', 1, 'agent',
                now() - interval '4 hours')
      `);
    }
    if (i === 3) {
      // case 4: an OLD phase that ENDED recently — greatest(started, ended)
      // is the live signal, and ordering by started_at would miss it.
      await db.execute(sql`
        INSERT INTO phase_journal (id, project_id, run_id, phase, attempt, source,
                                   started_at, ended_at)
        VALUES (${randomUUID()}, ${projectId}, ${runId}, 'phase-2', 1, 'agent',
                now() - interval '4 hours', now() - interval '2 minutes')
      `);
    }
    if (resident) {
      // case 6: a duplex turn already wrote a `result`; RESULT_GUARD must
      // still let this job through because the session declares a state.
      await db.execute(sql`
        INSERT INTO job_events (id, job_id, kind, data, seq, ts)
        VALUES (${randomUUID()}, ${jobId}, 'result', '{}'::jsonb, 1,
                now() - interval '3 hours')
      `);
    }
    if (i === 1 || i >= 6) {
      await db.execute(sql`
        INSERT INTO job_events (id, job_id, kind, data, seq, ts)
        VALUES (${randomUUID()}, ${jobId}, 'progress', '{}'::jsonb, 1,
                now() - interval '3 hours')
      `);
    }
    // cm:guard the long tail and the phase histories hang off ACTIVE jobs, because an active job
    // is the only kind the laterals ever drive on. Hung off the archive instead they make the
    // table big and make every driving lookup trivial, so criterion 6's row bound passes on a
    // fixture where each live job owns one event and nothing has been asked of the index — which
    // is exactly the plan this change exists to remove, going green.
    if (i === 6) {
      await db.execute(sql`
        INSERT INTO job_events (id, job_id, kind, data, seq, ts)
        SELECT gen_random_uuid(), ${jobId}, 'progress', '{}'::jsonb, 1 + g,
               now() - interval '3 hours' - ((${BUSIEST_JOB_EVENTS} - g) * interval '1 second')
        FROM generate_series(1, ${BUSIEST_JOB_EVENTS}) g
        ORDER BY g
      `);
    }
    if (i >= 6) {
      // Old, and ended: this run has declared phases and has still gone quiet, so it stays a
      // candidate. Cases 1-5 above keep the phase shapes they are named for.
      await db.execute(sql`
        INSERT INTO phase_journal (id, project_id, run_id, phase, attempt, source,
                                   started_at, ended_at)
        SELECT gen_random_uuid(), ${projectId}, ${runId}, 'phase-' || p, 1, 'agent',
               now() - interval '4 hours' + (p * interval '1 minute'),
               now() - interval '4 hours' + (p * interval '1 minute') + interval '30 seconds'
        FROM generate_series(1, ${PHASES_PER_RUN}) p
      `);
    }
  }
}

let harness: TestDatabase;
let projectId: string;
let ownerId: string;
let resultMissCandidateQuery: (scope?: { projectId?: string }) => ReturnType<typeof sql>;
let staleAlarmQuery: (now?: Date) => ReturnType<typeof sql>;
let orphanedJobAlarmQuery: (now?: Date, scope?: { projectId?: string }) => ReturnType<typeof sql>;
// cm:guard the guard fragments are IMPORTED and never retyped here. This file's whole reason for
// exporting the sweeper's queries is that a test written against a copy measures the copy; the
// same applies to the two fragments the test below exists to tell apart.
let RESIDENT_SESSION_JOIN: ReturnType<typeof sql>;
let RESULT_EVENT_LATERAL: ReturnType<typeof sql>;
let RESULT_GUARD: ReturnType<typeof sql>;
let neverClaimedAlarmQuery: (now?: Date, scope?: { projectId?: string }) => ReturnType<typeof sql>;

function ownBuffers(node: PlanNode): number {
  return (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0);
}

/** Every node of an ANALYZEd plan for one query, plus its total buffers. */
async function planOf(query: ReturnType<typeof sql>): Promise<{
  nodes: PlanNode[];
  buffers: number;
}> {
  const rows = await harness.db.execute<Record<string, unknown>>(
    sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
  );
  const raw = Object.values(rows[0] as Record<string, unknown>)[0];
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
  const root = parsed[0]?.Plan as PlanNode;
  const nodes = flatten(root);
  // cm:guard the total is the ROOT's and never the sum of the tree. EXPLAIN (BUFFERS) reports
  // every node's counts INCLUSIVE of its children, so adding the flattened nodes up charges the
  // same block once per ancestor above it — and the before/after ratio criterion 8 asserts is
  // then a function of how deep each plan happens to be rather than of what either one read. The
  // two plans here are of different depths, so this is not a rounding error in one direction.
  const buffers = ownBuffers(root);
  return { nodes, buffers };
}

function nodesOn(nodes: PlanNode[], relation: string): PlanNode[] {
  return nodes.filter((n) => n['Relation Name'] === relation);
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  ({ resultMissCandidateQuery } = await import('../../src/jobs/loop-monitor.js'));
  ({ staleAlarmQuery } = await import('../../src/jobs/stale-detector.js'));
  ({ orphanedJobAlarmQuery, neverClaimedAlarmQuery } = await import(
    '../../src/pipeline/sweeper.js'
  ));
  ({ RESIDENT_SESSION_JOIN, RESULT_EVENT_LATERAL, RESULT_GUARD } = await import(
    '../../src/jobs/resident-session.js'
  ));

  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  projectId = (await createTestProject(harness.db, ownerId)).id;

  // The archive: terminal jobs and their runs, carrying the history the old
  // aggregate had to read in full before it could answer anything.
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    SELECT gen_random_uuid(), ${projectId}, 'pm', 'completed',
           now() - ((${ARCHIVE_JOBS} - g) * interval '30 minutes')
    FROM generate_series(1, ${ARCHIVE_JOBS}) g
  `);
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status,
                      queued_at, dispatched_at, finished_at)
    SELECT gen_random_uuid(), ${projectId}, pr.id, ${ownerId}, 'drive', 'done',
           pr.started_at, pr.started_at, pr.started_at + interval '20 minutes'
    FROM pipeline_runs pr WHERE pr.project_id = ${projectId}
  `);
  // cm:guard `ORDER BY g` and ONE statement, because physical order is what `pg_stats.correlation` measures and the fixture asserts it below. Shuffle this and the planner reads a differently-clustered table, which is a different question from the one this file asks.
  await harness.db.execute(sql`
    WITH numbered AS (
      SELECT id, (row_number() OVER (ORDER BY dispatched_at)) - 1 AS n
      FROM jobs WHERE project_id = ${projectId} AND status = 'done'
    )
    INSERT INTO job_events (id, job_id, kind, data, seq, ts)
    SELECT gen_random_uuid(), nu.id, 'progress', '{}'::jsonb, g,
           now() - ((${EVENT_ROWS} - g) * interval '1 second')
    FROM generate_series(1, ${EVENT_ROWS}) g
    JOIN numbered nu ON nu.n = g % ${ARCHIVE_JOBS}
    ORDER BY g
  `);
  // cm:guard every archive job also wrote the `result` event that ended it, and the fixture is
  // dishonest without them. `job_events_result_idx` is PARTIAL on `kind = 'result'`, so its size
  // is one row per job that has ever finished -- which is what the laterals reading it are
  // measured against. Seed no results and that index holds a single row, every plan over it is
  // trivially cheap, and criteria 4-8 report on a table the deployment does not have. Measured:
  // with 1 row the planner read the whole index and criterion 18 failed; with one per archive job
  // it keys on the driving row.
  // cm:why both constants carry an explicit `::int`: two bind parameters added together are
  // `unknown + unknown`, which Postgres refuses as an ambiguous operator rather than guessing.
  await harness.db.execute(sql`
    INSERT INTO job_events (id, job_id, kind, data, seq, ts)
    SELECT gen_random_uuid(), j.id, 'result', '{}'::jsonb,
           ${EVENT_ROWS}::int + ${BUSIEST_JOB_EVENTS}::int + row_number() OVER (ORDER BY j.dispatched_at),
           j.finished_at
    FROM jobs j WHERE j.project_id = ${projectId} AND j.status = 'done'
  `);

  // An archive job with a long tail, so the table's shape is a real one. The tail that is
  // MEASURED on is the live job's in `seedLiveJobs` — this one is never a driving row.
  const tailJobRows = await harness.db.execute<{ id: string }>(sql`
    SELECT id FROM jobs WHERE project_id = ${projectId} AND status = 'done'
    ORDER BY dispatched_at LIMIT 1
  `);
  await harness.db.execute(sql`
    INSERT INTO job_events (id, job_id, kind, data, seq, ts)
    SELECT gen_random_uuid(), ${tailJobRows[0]?.id}, 'progress', '{}'::jsonb,
           ${EVENT_ROWS} + g, now() - ((${BUSIEST_JOB_EVENTS} - g) * interval '1 second')
    FROM generate_series(1, ${BUSIEST_JOB_EVENTS}) g
  `);
  await harness.db.execute(sql`
    INSERT INTO phase_journal (id, project_id, run_id, phase, attempt, source, started_at, ended_at)
    SELECT gen_random_uuid(), ${projectId}, pr.id, 'phase-' || p, 1, 'agent',
           pr.started_at + (p * interval '1 minute'),
           pr.started_at + (p * interval '1 minute') + interval '30 seconds'
    FROM pipeline_runs pr, generate_series(1, ${PHASES_PER_RUN}) p
    WHERE pr.project_id = ${projectId}
  `);

  await seedLiveJobs(harness.db, projectId, ownerId);
  await harness.db.execute(sql`ANALYZE`);
}, 600_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe('ISS-1013 · the quiet-job candidate query is bounded by live jobs', () => {
  it('is planted at the shape the plans below are read on', async () => {
    const [events] = await harness.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM job_events
    `);
    expect(Number(events?.n)).toBeGreaterThan(1_000_000); // MEASURED: beta held 3.9M

    // cm:guard the busiest job is counted among the ACTIVE ones and not over the table. A tail
    // sitting on a terminal job is history the laterals never drive on, so the global maximum
    // says nothing about what one lookup costs — and the bound it was written to defend is
    // precisely that a live job's whole history is not read to answer `max(ts)` for it.
    const [busiest] = await harness.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n
      FROM job_events e JOIN jobs j ON j.id = e.job_id
      WHERE j.project_id = ${projectId} AND j.status IN ('dispatched', 'running')
      GROUP BY e.job_id ORDER BY count(*) DESC LIMIT 1
    `);
    expect(Number(busiest?.n)).toBeGreaterThanOrEqual(1_000); // CHOSEN

    const [live] = await harness.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM jobs
      WHERE project_id = ${projectId} AND status IN ('dispatched', 'running')
    `);
    expect(Number(live?.n)).toBeGreaterThanOrEqual(40); // CHOSEN, above 7 live runs on beta

    // cm:guard driven from the active runs by LEFT JOIN, so a run carrying NO phases is still a
    // row here. Grouping `phase_journal` alone drops every zero-phase run out of the average,
    // which is how a fixture whose live runs have no phase history at all reports a healthy one.
    const phaseCounts = await harness.db.execute<{ c: string }>(sql`
      SELECT count(p.id)::text AS c
      FROM pipeline_runs r
      JOIN jobs j ON j.pipeline_run_id = r.id AND j.status IN ('dispatched', 'running')
      LEFT JOIN phase_journal p ON p.run_id = r.id
      WHERE r.project_id = ${projectId}
      GROUP BY r.id
    `);
    const bulk = [...phaseCounts].map((r) => Number(r.c)).filter((c) => c >= 8 && c <= 40); // CHOSEN
    const exempt = [...phaseCounts].map((r) => Number(r.c)).filter((c) => c < 8);
    expect(bulk.length).toBe(LIVE_JOBS - 6);
    expect(exempt.length).toBe(6); // the six named equality cases, and only those

    // cm:guard physical order is the third variable a planner reads, and the sign is load bearing: a fixture built descending measures about -0.95 and would pass any assertion written on the absolute value while planning nothing like an append-only event table.
    const [stats] = await harness.db.execute<{ correlation: string }>(sql`
      SELECT correlation::text AS correlation FROM pg_stats
      WHERE tablename = 'job_events' AND attname = 'ts'
    `);
    expect(Number(stats?.correlation)).toBeGreaterThan(0.9); // CHOSEN
  });

  it('reaches job_events only by an index condition on the driving job row', async () => {
    const { nodes } = await planOf(resultMissCandidateQuery({ projectId }));
    const events = nodesOn(nodes, 'job_events');

    expect(events.length).toBeGreaterThan(0);
    for (const node of events) {
      // cm:guard the assertion is the CONDITION each node was bound by and not the absence of a sequential scan, and that distinction is this repository's own: `0250_bounded_read_indexes.sql` records the planner on this deployment declining a seq scan and reading a WHOLE index instead, which prints as an index scan and costs like a table scan. A test written on `Seq Scan` stays green through exactly the regression this change removes — and so does one written on `Index Cond` alone, because a hashed SubPlan's own scan carries neither.
      expect(`${node['Node Type']} ${boundBy(node)}`).toMatch(/job_id/);
    }
    const names = nodes.map((n) => n['Index Name']);
    expect(names).toContain('job_events_job_id_ts_idx');
    expect(names).toContain('job_events_result_idx');
  });

  it('reaches phase_journal only by an index condition on the driving run', async () => {
    const { nodes } = await planOf(resultMissCandidateQuery({ projectId }));
    const phases = nodesOn(nodes, 'phase_journal');

    expect(phases.length).toBeGreaterThan(0);
    for (const node of phases) {
      expect(boundBy(node)).toMatch(/run_id/);
    }
    expect(nodes.some((n) => (n['Index Name'] ?? '').startsWith('phase_journal_run'))).toBe(true);
  });

  it('reads a number of job_events rows set by the live jobs, not by the table', async () => {
    const { nodes } = await planOf(resultMissCandidateQuery({ projectId }));
    const read = nodesOn(nodes, 'job_events').reduce(
      (n, p) => n + (p['Actual Rows'] ?? 0) * (p['Actual Loops'] ?? 1),
      0,
    );

    const [total] = await harness.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM job_events`,
    );
    expect(Number(total?.n)).toBeGreaterThan(1_000_000);
    expect(read).toBeLessThan(LIVE_JOBS * 10);
  });

  it('costs an order of magnitude fewer buffers than the query it replaces', async () => {
    const before = await planOf(REPLACED_CTE_QUERY(projectId, 60));
    const after = await planOf(resultMissCandidateQuery({ projectId }));

    // cm:guard the accounting model `planOf` rests on, asserted rather than assumed: a node's
    // buffer counts include its children's, so the root's total dominates every node under it.
    // Were that false the root would be a partial reading and this ratio would mean nothing,
    // and nothing else in this file would notice.
    for (const plan of [before, after]) {
      for (const node of plan.nodes) {
        expect(ownBuffers(node)).toBeLessThanOrEqual(plan.buffers);
      }
    }
    expect(after.buffers).toBeGreaterThan(0);
    expect(after.buffers * 10).toBeLessThan(before.buffers);
  });
});

// cm:guard a SECOND describe, and the split is at the seam between the two questions this file
// asks rather than wherever the line budget happened to bite. Above: what the plans cost, which is
// a property of the fixture. Below: which rows come back, which is a property of the query. They
// share the one fixture because building it twice costs a minute and proves nothing extra.
describe('ISS-1013 · the rewritten query picks what the CTE picked, and the alarm agrees', () => {
  it('picks exactly the jobs the replaced query picked', async () => {
    const replaced = await harness.db.execute<{ id: string }>(REPLACED_CTE_QUERY(projectId, 60));
    const rewritten = await harness.db.execute<{ id: string }>(
      resultMissCandidateQuery({ projectId }),
    );

    const oldIds = [...replaced].map((r) => r.id).sort();
    const newIds = [...rewritten].map((r) => r.id).sort();
    // cm:guard the equality is worthless against two empty sets, and an empty answer is exactly what a rewrite that narrowed too far produces — so the count is asserted before the sets are compared.
    expect(oldIds.length).toBeGreaterThan(0);
    expect(newIds).toEqual(oldIds);
  });

  it('leaves alive the job whose only signal is a phase, and the parked one', async () => {
    const picked = new Set(
      [...(await harness.db.execute<{ id: string }>(resultMissCandidateQuery({ projectId })))].map(
        (r) => r.id,
      ),
    );

    const [recentPhase] = await harness.db.execute<{ id: string }>(sql`
      SELECT j.id FROM jobs j
      JOIN phase_journal p ON p.run_id = j.pipeline_run_id
      WHERE j.project_id = ${projectId} AND j.status = 'running'
        AND p.ended_at > now() - interval '10 minutes'
    `);
    expect(recentPhase?.id).toBeDefined();
    expect(picked.has(recentPhase?.id as string)).toBe(false);

    const [parked] = await harness.db.execute<{ id: string }>(sql`
      SELECT j.id FROM jobs j JOIN agent_sessions s ON s.id = j.agent_session_id
      WHERE j.project_id = ${projectId} AND s.runtime_state = 'awaiting_input'
    `);
    expect(parked?.id).toBeDefined();
    expect(picked.has(parked?.id as string)).toBe(false);
  });

  it('still picks a resident session whose earlier turn wrote a result', async () => {
    const picked = new Set(
      [...(await harness.db.execute<{ id: string }>(resultMissCandidateQuery({ projectId })))].map(
        (r) => r.id,
      ),
    );
    const [resident] = await harness.db.execute<{ id: string }>(sql`
      SELECT j.id FROM jobs j JOIN agent_sessions s ON s.id = j.agent_session_id
      WHERE j.project_id = ${projectId} AND s.runtime_state = 'working'
        AND EXISTS (SELECT 1 FROM job_events e WHERE e.job_id = j.id AND e.kind = 'result')
    `);
    expect(resident?.id).toBeDefined();
    expect(picked.has(resident?.id as string)).toBe(true);
  });

  it('bounds the alarm the same way, and drops a job inside the kill grace', async () => {
    const { nodes } = await planOf(staleAlarmQuery(new Date()));
    expect(nodesOn(nodes, 'job_events').length).toBeGreaterThan(0);
    for (const node of nodesOn(nodes, 'job_events')) {
      expect(`${node['Node Type']} ${boundBy(node)}`).toMatch(/job_id/);
    }

    const before = await harness.db.execute<{ id: string }>(staleAlarmQuery(new Date()));
    const target = [...before][0]?.id;
    expect(target).toBeDefined();
    await harness.db.execute(
      sql`UPDATE jobs SET kill_requested_at = now() WHERE id = ${target as string}`,
    );
    try {
      const after = await harness.db.execute<{ id: string }>(staleAlarmQuery(new Date()));
      expect([...after].map((r) => r.id)).not.toContain(target);
    } finally {
      await harness.db.execute(
        sql`UPDATE jobs SET kill_requested_at = NULL WHERE id = ${target as string}`,
      );
    }
  });

  // cm:guard measured on the ALARM'S OWN ROWS and not on its SQL text. The unit test asserts
  // that the phase, park and residency fragments are present; present is not the same as
  // effective, and the question criterion 15 asks is which jobs come back. Both jobs below are
  // quiet by `job_events` alone and well past the alarm's 65-minute threshold, so an alarm that
  // lost either term reports them — which is the false operator alert every five minutes that
  // this change removes.
  it('raises no loop-miss for a job the result hop deliberately leaves alive', async () => {
    const alarmed = new Set(
      [...(await harness.db.execute<{ id: string }>(staleAlarmQuery(new Date())))].map((r) => r.id),
    );
    expect(alarmed.size).toBeGreaterThan(0);

    const [recentPhase] = await harness.db.execute<{ id: string }>(sql`
      SELECT j.id FROM jobs j
      JOIN phase_journal p ON p.run_id = j.pipeline_run_id
      WHERE j.project_id = ${projectId} AND j.status = 'running'
        AND p.ended_at > now() - interval '10 minutes'
    `);
    expect(recentPhase?.id).toBeDefined();
    expect(alarmed.has(recentPhase?.id as string)).toBe(false);

    const [parked] = await harness.db.execute<{ id: string }>(sql`
      SELECT j.id FROM jobs j JOIN agent_sessions s ON s.id = j.agent_session_id
      WHERE j.project_id = ${projectId} AND s.runtime_state = 'awaiting_input'
    `);
    expect(parked?.id).toBeDefined();
    expect(alarmed.has(parked?.id as string)).toBe(false);
  });

  // cm:guard the two queries come from `sweeper.ts` and are NOT pasted here. They used to be
  // copies, and the copies had already drifted: both dropped the kill-gate term and
  // `neverClaimed` dropped `j.dispatched_at < cutoff`, which are predicates that change
  // selectivity and so change the plan. A criterion about the sweeper's cost, measured on a
  // likeness of the sweeper, is the failure `resultMissCandidateQuery` was exported to prevent.
  it('bounds the two sweeper job alarms the same way', async () => {
    const now = new Date();
    const cases: Array<[string, ReturnType<typeof sql>]> = [
      ['alarmOrphanedJobs', orphanedJobAlarmQuery(now, { projectId })],
      ['alarmNeverClaimedDispatches', neverClaimedAlarmQuery(now, { projectId })],
    ];
    for (const [label, query] of cases) {
      const { nodes } = await planOf(query);
      const read = nodesOn(nodes, 'job_events');
      expect(read.length, `${label} reads job_events in no node at all`).toBeGreaterThan(0);
      for (const node of read) {
        expect(
          `${node['Node Type']} ${boundBy(node)}`,
          `${label}: this job_events node is not keyed on the driving job — ${JSON.stringify(node['Node Type'])} over ${JSON.stringify(node['Index Name'] ?? '(no index)')}, rows ${String(node['Actual Rows'] ?? '?')}`,
        ).toMatch(/job_id/);
      }
    }
  });

  // cm:guard the ONLY assertion in this repository that goes red if `RESULT_EVENT_LATERAL` is
  // reverted to the `NOT EXISTS` it replaced, and it exists because every other assertion here
  // stays green through that revert — measured, not assumed. With `job_events_result_idx` present
  // the planner gives BOTH forms an Index Only Scan keyed on the driving job (97 buffers against
  // 102 on this fixture), so criterion 4 cannot tell them apart and a reader would reasonably
  // conclude the lateral was redundant. It is not: the index is what makes the guard cheap, and
  // the lateral is what makes it cheap WITHOUT the index. So the index is dropped here, which is
  // the one condition under which the two forms diverge at all.
  it('keeps the result guard bounded even with the partial index dropped', async () => {
    const guardOnly = (extra: ReturnType<typeof sql>, guard: ReturnType<typeof sql>) => sql`
      SELECT j.id FROM jobs j
      ${RESIDENT_SESSION_JOIN}
      ${extra}
      WHERE j.status IN ('dispatched', 'running') AND j.project_id = ${projectId}
        AND ${guard}`;
    // The control is the text this change replaced, written out because a control has to be the
    // OLD one. The subject is the shipped fragments themselves, so reverting them reddens this.
    const notExists = guardOnly(
      sql``,
      sql`(s.runtime_state IS NOT NULL OR NOT EXISTS (SELECT 1 FROM job_events WHERE job_id = j.id AND kind = 'result'))`,
    );
    const lateral = guardOnly(RESULT_EVENT_LATERAL, RESULT_GUARD);

    // cm:guard restored in `finally`: every later test in this file reads a plan, and one left
    // running against a half-indexed fixture reports a regression that is this test's litter.
    await harness.db.execute(sql.raw('DROP INDEX job_events_result_idx'));
    try {
      await harness.db.execute(sql.raw('ANALYZE job_events'));
      const shipped = await planOf(lateral);
      const replaced = await planOf(notExists);

      // The two forms return the same rows — the divergence is entirely in the plan.
      const ids = async (q: ReturnType<typeof sql>) =>
        [...(await harness.db.execute<{ id: string }>(q))].map((r) => r.id).sort();
      expect(await ids(lateral)).toEqual(await ids(notExists));

      // Every `job_events` node the shipped form reads is still keyed on the driving job...
      const shippedNodes = nodesOn(shipped.nodes, 'job_events');
      expect(shippedNodes.length).toBeGreaterThan(0);
      for (const node of shippedNodes) {
        expect(
          `${node['Node Type']} ${boundBy(node)}`,
          `without the partial index the lateral fell back to ${JSON.stringify(node['Node Type'])}`,
        ).toMatch(/job_id/);
      }

      // ...and the form it replaced is not, which is what makes the lateral load-bearing.
      expect(shipped.buffers * 10).toBeLessThan(replaced.buffers);
    } finally {
      await harness.db.execute(
        sql.raw(
          "CREATE INDEX job_events_result_idx ON job_events USING btree (job_id) WHERE kind = 'result'",
        ),
      );
      await harness.db.execute(sql.raw('ANALYZE job_events'));
    }
  });
});
