/**
 * ISS-1015 — every session-scoped `usage_records` rollup is served by
 * `usage_records_session_id_idx`, and the `pipeline_run_step_durations` view no
 * longer runs a subquery per job row.
 *
 * An index that exists proves nothing and a cost estimate is not a test, so
 * what this file asserts is the plan the planner actually chose, on a fixture
 * whose row count, session cardinality and selectivity are fixed here rather
 * than left to judgement — the planner reads all three, and a fixture of
 * twenty rows takes a sequential scan whatever the predicate says.
 *
 * Fixture, sized on beta as it stood on 2026-09-17 (24,085 usage rows over
 * 15,657 distinct session ids, 21,899 agent sessions, 31,197 jobs, 7,880 runs):
 *   16,000 agent_sessions over 5,000 pipeline_runs  (~3.2 sessions per run)
 *    8,000 jobs over 2,000 issues, one session each  (4 jobs per issue)
 *   24,000 usage_records over those 16,000 sessions  (1.5 rows per session)
 * `ANALYZE` runs before any plan is read.
 *
 * Every assertion below carries the fraction of the 24,000 it selects, because
 * that fraction is what decides the plan. The negative control is the point of
 * the file: the predicate this change removed must read `Seq Scan on
 * usage_records` on this same fixture, or none of the assertions above it is
 * able to fail.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSessions, jobs as jobsTable, usageRecords } from '../../src/db/schema.js';
import { canonicalSessionId, usageSessionMatch } from '../../src/usage-records/rollup.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  type TestDb,
  truncateAll,
} from '../helpers/index.js';

const RUNS = 5_000;
const SESSIONS = 16_000;
const JOBS = 8_000;
const ISSUES = 2_000;
const USAGE_ROWS = 24_000;

/**
 * Deterministic uuids so a selection can be written without reading ids back.
 *
 * cm:guard the literal `ab` in every node is what keeps a hex LETTER in each id, and it
 * is not decoration. Without it `sessionId(1)` is `...000000000001`, all digits, and
 * `toUpperCase()` on it is a no-op — so the two cases below that exist to prove an
 * uppercase spelling is handled would have been comparing a string with itself. That
 * happened twice while this file was written; putting the letters in the generator is
 * what stops it happening a third time in whatever case someone adds next.
 */
const node = (g: number) => `ab${g.toString(16).padStart(10, '0')}`;
const runId = (g: number) => `20000000-0000-4000-8000-${node(g)}`;
const sessionId = (g: number) => `10000000-0000-4000-8000-${node(g)}`;
const issueId = (g: number) => `30000000-0000-4000-8000-${node(g)}`;

/** The 0177 shape of `cost_usd`: one correlated subquery per job row. */
const LEGACY_VIEW = sql`
  SELECT
    j.pipeline_run_id AS run_id, r.issue_id, r.project_id, j.type AS step,
    COALESCE(s.started_at, j.dispatched_at) AS started_at, j.finished_at,
    CASE WHEN j.status = 'done' AND j.finished_at >= COALESCE(s.started_at, j.dispatched_at)
         THEN EXTRACT(EPOCH FROM (j.finished_at - COALESCE(s.started_at, j.dispatched_at)))::float
         ELSE NULL END AS duration_seconds,
    COALESCE((SELECT SUM(ur.estimated_cost)::float FROM usage_records ur
              WHERE ur.session_id = j.agent_session_id::text), 0) AS cost_usd,
    j.device_id, j.model_used
  FROM jobs j
  INNER JOIN pipeline_runs r ON r.id = j.pipeline_run_id
  LEFT JOIN agent_sessions s ON s.id = j.agent_session_id
  WHERE j.finished_at IS NOT NULL
    AND (s.started_at IS NOT NULL OR j.dispatched_at IS NOT NULL)`;

/** The fixture, seeded once. Kept out of the describe body so the suite stays inside the
 *  per-function line budget rather than buying an exemption from it. */
async function seedFixture(db: TestDb, projectId: string, ownerId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    SELECT ('30000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'))::uuid,
           ${projectId}, g, 'seeded ' || g, 'open', ${ownerId}
    FROM generate_series(1, ${ISSUES}) g`);

  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    SELECT ('20000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'))::uuid,
           ${projectId}, 'system', 'running', now() - (g * interval '1 minute')
    FROM generate_series(1, ${RUNS}) g`);

  await db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, status, started_at)
    SELECT ('10000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'))::uuid, ${projectId},
           ('20000000-0000-4000-8000-ab' || lpad(to_hex(((g - 1) % ${RUNS}) + 1), 10, '0'))::uuid,
           'idle', now() - (g * interval '1 second')
    FROM generate_series(1, ${SESSIONS}) g`);

  // Jobs 1..8000 carry sessions 1..8000. `status` cycles through the REAL members of
  // `jobStatuses` — `done`, `failed`, `cancelled` — because the view yields a duration only
  // for `done`: seeded with a status the enum does not hold, every row's `duration_seconds`
  // is NULL and the equivalence case cannot tell the two views' duration expressions apart.
  // Every 500th job's span is inverted, finished before started, so the guard 0128 added is
  // exercised on both of its sides.
  await db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status,
                      agent_session_id, dispatched_at, finished_at, model_used)
    SELECT ('40000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'))::uuid, ${projectId},
           ('30000000-0000-4000-8000-ab' || lpad(to_hex(((g - 1) % ${ISSUES}) + 1), 10, '0'))::uuid,
           ('20000000-0000-4000-8000-ab' || lpad(to_hex(((g - 1) % ${RUNS}) + 1), 10, '0'))::uuid,
           ${ownerId}, 'plan',
           (ARRAY['done','failed','cancelled'])[(g % 3) + 1]::text,
           ('10000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'))::uuid,
           now() - (g * interval '1 second'),
           CASE WHEN g % 500 = 0 THEN now() - (g * interval '1 second') - interval '5 second'
                ELSE now() - (g * interval '1 second') + interval '30 second' END,
           'claude-opus-4-7'
    FROM generate_series(1, ${JOBS}) g`);

  // Two more shapes the view has to carry unchanged: a job with no session at
  // all, and a job whose session exists but has produced no usage row.
  await db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, created_by, type, status,
                      agent_session_id, dispatched_at, finished_at, model_used)
    SELECT ('50000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'))::uuid, ${projectId}, NULL,
           ('20000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'))::uuid, ${ownerId}, 'plan',
           'done',
           CASE WHEN g % 2 = 0 THEN NULL
                ELSE ('10000000-0000-4000-8000-ab' || lpad(to_hex(${SESSIONS} + g), 10, '0'))::uuid END,
           now() - interval '1 hour', now() - interval '30 minute', NULL
    FROM generate_series(1, 200) g`);

  // 24,000 rows over the 16,000 sessions, written in two ascending passes so a
  // session's rows land together the way they accrue on the deployment.
  for (const [count, tag] of [
    [SESSIONS, 'first'],
    [USAGE_ROWS - SESSIONS, 'second'],
  ] as Array<[number, string]>) {
    await db.execute(sql`
      INSERT INTO usage_records (id, project_id, source, model, input_tokens, output_tokens,
                                 estimated_cost, request_count, session_id, recorded_at)
      SELECT gen_random_uuid(), ${projectId}, 'cli', 'claude-opus-4-7', 100 + g, 10 + g,
             (g % 97)::real / 1000.0, 1,
             '10000000-0000-4000-8000-ab' || lpad(to_hex(g), 10, '0'),
             now() - (g * interval '1 second') - ${sql.raw(`interval '${tag === 'first' ? 0 : 1} hour'`)}
      FROM generate_series(1, ${count}) g`);
  }

  await db.execute(sql`ANALYZE`);
}

/** criteria 17 — kept out of the describe body for the per-function line budget. */
async function expectViewMatchesLegacy(db: TestDb): Promise<void> {
  const columns = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'pipeline_run_step_durations' ORDER BY ordinal_position`);
  expect([...columns].map((c) => c.column_name)).toEqual([
    'run_id',
    'issue_id',
    'project_id',
    'step',
    'started_at',
    'finished_at',
    'duration_seconds',
    'cost_usd',
    'device_id',
    'model_used',
  ]);

  const [diff] = await db.execute<{ missing: string; extra: string }>(sql`
      SELECT (SELECT count(*) FROM (SELECT * FROM pipeline_run_step_durations
                                    EXCEPT ALL ${LEGACY_VIEW}) a)::text AS extra,
             (SELECT count(*) FROM (${LEGACY_VIEW}
                                    EXCEPT ALL SELECT * FROM pipeline_run_step_durations) b)::text AS missing`);
  expect({ extra: diff?.extra, missing: diff?.missing }).toEqual({ extra: '0', missing: '0' });

  // And the fixture must actually hold the shapes the equality is claimed over,
  // or the two EXCEPTs above agree on a row set that exercises none of them.
  const [shapes] = await db.execute<Record<string, string>>(sql`
      SELECT count(*) FILTER (WHERE cost_usd = 0)::text AS costless,
             count(*) FILTER (WHERE cost_usd > 0)::text AS priced,
             count(*) FILTER (WHERE duration_seconds IS NULL)::text AS no_duration,
           count(*) FILTER (WHERE duration_seconds > 0)::text AS positive_duration,
             count(DISTINCT step)::text AS steps
      FROM pipeline_run_step_durations`);
  expect(Number(shapes?.costless)).toBeGreaterThan(0);
  expect(Number(shapes?.priced)).toBeGreaterThan(0);
  expect(Number(shapes?.no_duration)).toBeGreaterThan(0);
  // cm:guard BOTH sides of the 0128 duration guard, because only one of them is free: a fixture
  // whose jobs never reach `done` yields NULL for every row, and the equality above then holds
  // between two views whose duration expressions could differ in any way at all.
  expect(Number(shapes?.positive_duration)).toBeGreaterThan(0);
}

describe('ISS-1015 · usage_records rollups are index-served', () => {
  let harness: TestDatabase;
  let projectId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    await truncateAll(harness.db);
    const owner = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, owner.id);
    projectId = project.id;
    await seedFixture(harness.db, projectId, owner.id);
  }, 600_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  const plan = async (query: ReturnType<typeof sql>): Promise<string> => {
    const rows = await harness.db.execute<Record<string, string>>(
      sql`EXPLAIN (COSTS OFF) ${query}`,
    );
    return [...rows].map((r) => Object.values(r)[0]).join('\n');
  };

  /**
   * What every index-served assertion here means, in one place.
   *
   * cm:guard the predicate under EXPLAIN is built by the REAL `usageSessionMatch` and
   * `canonicalSessionId` rather than hand-copied into this file. A likeness would make the
   * negative control prove only that Postgres distinguishes two predicates — true and not
   * the claim — while a regression in the helper kept every case green.
   */
  const expectIndexServed = (text: string) => {
    expect(text).toContain('usage_records_session_id_idx');
    expect(text).not.toContain('Seq Scan on usage_records');
  };

  const totals = sql`coalesce(sum(${usageRecords.estimatedCost}), 0)::float AS cost, count(*)::int AS n`;

  it('seeds the fixture at the deployment order of magnitude and cardinality', async () => {
    const [counts] = await harness.db.execute<{ n: string; sessions: string }>(sql`
      SELECT count(*)::text AS n, count(DISTINCT session_id)::text AS sessions FROM usage_records`);
    expect(Number(counts?.n)).toBe(USAGE_ROWS);
    expect(Number(counts?.sessions)).toBe(SESSIONS);
  });

  // criteria 1 — one session out of 16,000: about 2 rows, 0.008% of the table.
  it('serves GET /agent-sessions/:id/cost from the index', async () => {
    expectIndexServed(
      await plan(
        sql`SELECT ${totals} FROM ${usageRecords} WHERE ${usageSessionMatch(sql`= ${canonicalSessionId(sessionId(42))}`)}`,
      ),
    );
  });

  // criteria 2 — a list page of 25 sessions: about 38 rows, 0.16%.
  it('serves the agent-sessions list-page cost rollup from the index', async () => {
    const page = sql.join(
      Array.from({ length: 25 }, (_, i) => canonicalSessionId(sessionId(i + 1))),
      sql`, `,
    );
    expectIndexServed(
      await plan(
        sql`SELECT ${usageRecords.sessionId}, ${totals} FROM ${usageRecords}
            WHERE ${usageSessionMatch(sql`IN (${page})`)} GROUP BY ${usageRecords.sessionId}`,
      ),
    );
  });

  // criteria 3 — one issue's sessions: 4 sessions, about 6 rows.
  it('serves GET /issues/:id/cost-summary from the index', async () => {
    const sessionIds = sql`(
      SELECT DISTINCT ${jobsTable.agentSessionId}::text FROM ${jobsTable}
      WHERE ${jobsTable.issueId} = ${issueId(7)} AND ${jobsTable.agentSessionId} IS NOT NULL)`;
    expectIndexServed(
      await plan(
        sql`SELECT ${totals} FROM ${usageRecords} WHERE ${usageSessionMatch(sql`IN ${sessionIds}`)}`,
      ),
    );
  });

  // criteria 4 — the issues-list rollup, at both widths, because they answer
  // differently and both answers are correct.
  //
  // cm:guard a broad page is NOT asserted to be an index scan, and forcing one would
  // be the wrong fix. One issue resolves about 4 sessions and takes a nested loop over
  // the index; a 25-issue page resolves about 100 (224 on beta, of 15,657), and at that
  // width Postgres legitimately prefers to hash `usage_records` whole rather than probe
  // the index a hundred times. What this change buys the wide case is not an index scan
  // but an uncast join key: measured on beta 2026-09-17 over a real 25-issue page, the
  // same rollup falls from 47.2ms at cost 5,273.81 (Merge Join on `(u.session_id)::uuid`)
  // to 6.2ms at cost 2,709.30. The criterion was written claiming an index scan at both
  // widths; that was wrong about the planner and is corrected on the issue rather than
  // relaxed here to match what got built.
  it('serves the issues-list rollup from the index for one issue', async () => {
    expectIndexServed(
      await plan(sql`
        SELECT p.issue_id, coalesce(sum(${usageRecords.estimatedCost}), 0)::float AS cost
        FROM (SELECT DISTINCT ${jobsTable.issueId} AS issue_id,
                     ${jobsTable.agentSessionId}::text AS session_id
              FROM ${jobsTable}
              WHERE ${jobsTable.issueId} = ${issueId(7)}
                AND ${jobsTable.agentSessionId} IS NOT NULL) p
        INNER JOIN ${usageRecords} ON ${usageSessionMatch(sql`= p.session_id`)}
        GROUP BY p.issue_id`),
    );
  });

  it('joins a 25-issue page on the uncast column, and cheaper than the cast did', async () => {
    const page = sql.join(
      Array.from({ length: 25 }, (_, i) => sql`${issueId(i + 1)}`),
      sql`, `,
    );
    const pageCost = async (join: ReturnType<typeof sql>, subselect: ReturnType<typeof sql>) => {
      const rows = await harness.db.execute<Record<string, string>>(sql`
        EXPLAIN SELECT p.issue_id, coalesce(sum(u.estimated_cost), 0)::float AS cost
        FROM (SELECT DISTINCT issue_id, ${subselect} FROM jobs
              WHERE issue_id IN (${page}) AND agent_session_id IS NOT NULL) p
        INNER JOIN usage_records u ON ${join}
        GROUP BY p.issue_id`);
      const text = [...rows].map((r) => Object.values(r)[0]).join('\n');
      return { text, total: Number(/cost=[\d.]+\.\.([\d.]+)/.exec(text)?.[1]) };
    };
    const now = await pageCost(
      sql`u.session_id = p.session_id`,
      sql`agent_session_id::text AS session_id`,
    );
    const before = await pageCost(
      sql`u.session_id ~ '^[0-9a-fA-F-]{36}$' AND u.session_id::uuid = p.agent_session_id`,
      sql`agent_session_id`,
    );
    expect(now.text).not.toContain('(u.session_id)::uuid');
    expect(before.text).toContain('(u.session_id)::uuid');
    expect(now.total).toBeLessThan(before.total);
  });

  // criteria 5 — one run (about 3 sessions), then a page of 25 runs (about 75, 0.5%).
  it('serves both pipeline-run cost rollups from the index', async () => {
    const joinOn = usageSessionMatch(sql`= ${agentSessions.id}::text`);
    expectIndexServed(
      await plan(sql`
        SELECT ${totals} FROM ${usageRecords}
        INNER JOIN ${agentSessions} ON ${joinOn}
        WHERE ${agentSessions.pipelineRunId} = ${runId(11)}`),
    );
    const page = sql.join(
      Array.from({ length: 25 }, (_, i) => sql`${runId(i + 1)}`),
      sql`, `,
    );
    expectIndexServed(
      await plan(sql`
        SELECT ${agentSessions.pipelineRunId}, ${totals} FROM ${usageRecords}
        INNER JOIN ${agentSessions} ON ${joinOn}
        WHERE ${agentSessions.pipelineRunId} IN (${page})
        GROUP BY ${agentSessions.pipelineRunId}`),
    );
  });

  // criteria 6 — the negative control. Without this the five cases above cannot
  // fail: they would be asserting that Postgres uses an index on a table small
  // enough to scan, rather than that this predicate lets it.
  it('plans the regex-and-cast predicate this change removed as a sequential scan', async () => {
    const text = await plan(sql`
      SELECT ${totals} FROM usage_records
      WHERE session_id ~ '^[0-9a-fA-F-]{36}$' AND session_id::uuid = ${sessionId(42)}::uuid`);
    expect(text).toContain('Seq Scan on usage_records');
    expect(text).not.toContain('usage_records_session_id_idx');
  });

  // criteria 7
  it('returns the same figures as the predicate it replaces', async () => {
    const one = async (where: ReturnType<typeof sql>) => {
      const [row] = await harness.db.execute<{ cost: number; n: number }>(
        sql`SELECT ${totals} FROM usage_records WHERE ${where}`,
      );
      return row;
    };
    for (const g of [1, 42, 8_000, 15_999]) {
      const now = await one(sql`session_id = ${sessionId(g)}::uuid::text`);
      const before = await one(
        sql`session_id ~ '^[0-9a-fA-F-]{36}$' AND session_id::uuid = ${sessionId(g)}::uuid`,
      );
      expect(now).toEqual(before);
      expect(now?.n).toBeGreaterThan(0);
    }
  });

  // criteria 8 — an uppercase id in a URL. Plain equality on the raw parameter
  // is what this case exists to refuse: it returns nothing and reports it as a
  // session that cost nothing, which is the substitution the ::uuid::text pair
  // closes.
  it('reads an uppercase-hex session id as the same session', async () => {
    const lower = sessionId(4_242);
    const upper = lower.toUpperCase();
    expect(upper).not.toBe(lower);
    const read = async (rhs: ReturnType<typeof sql>) => {
      const [row] = await harness.db.execute<{ cost: number; n: number }>(
        sql`SELECT ${totals} FROM usage_records WHERE session_id = ${rhs}`,
      );
      return row;
    };
    // through the real helper, so a canonicalisation that regresses fails here too
    const canonical = await read(canonicalSessionId(upper));
    expect(canonical).toEqual(await read(canonicalSessionId(lower)));
    expect(canonical?.n).toBeGreaterThan(0);
    expect((await read(sql`${upper}`))?.n).toBe(0);
  });

  // criteria 13
  it('refuses a session_id that is neither null nor a canonical lowercase uuid', async () => {
    // The constraint name is on the driver error, not on the wrapper drizzle throws,
    // so read it rather than matching the wrapper's message — which names the query
    // and would match a syntax error just as happily.
    const ACCEPTED = 'accepted';
    const refusedBy = async (query: ReturnType<typeof sql>): Promise<string> => {
      try {
        await harness.db.execute(query);
        return ACCEPTED;
      } catch (err) {
        const cause = (err as { cause?: { constraint_name?: string; constraint?: string } }).cause;
        // cm:guard naming the whole error when no constraint field is present, rather than
        // returning the same value an accepted write returns: the first version of this
        // helper answered `undefined` for both, so a run where the constraint did not exist
        // at all read identically to one where it refused.
        return (
          cause?.constraint_name ??
          cause?.constraint ??
          `refused, not by a constraint: ${String(err)}`
        );
      }
    };
    const write = (value: string) =>
      refusedBy(sql`
        INSERT INTO usage_records (id, project_id, source, model, estimated_cost, request_count,
                                   session_id, recorded_at)
        VALUES (gen_random_uuid(), ${projectId}, 'cli', 'm', 0, 1, ${value}, now())`);

    const CHK = 'usage_records_session_id_uuid_chk';
    expect(await write('session-42')).toBe(CHK);
    expect(await write(sessionId(1).toUpperCase())).toBe(CHK);
    expect(await write(sessionId(1).replace(/-/g, ''))).toBe(CHK);
    // 36 characters that pass the regex the old read-side guard used and fail the
    // cast it was guarding — the hole that guard never closed.
    expect(await write('-'.repeat(36))).toBe(CHK);

    // and on UPDATE, not only on INSERT
    expect(
      await refusedBy(sql`
        UPDATE usage_records SET session_id = ${sessionId(1).toUpperCase()}
        WHERE session_id = ${sessionId(1)}`),
    ).toBe(CHK);

    // null and a canonical value are still accepted, or the constraint is refusing
    // everything and the four cases above say nothing.
    expect(await write(sessionId(1))).toBe(ACCEPTED);
    expect(
      await refusedBy(sql`
        INSERT INTO usage_records (id, project_id, source, model, estimated_cost, request_count,
                                   session_id, recorded_at)
        VALUES (gen_random_uuid(), ${projectId}, 'cli', 'm', 0, 1, NULL, now())`),
    ).toBe(ACCEPTED);
  });

  // criteria 16
  it('computes the view cost without a subquery per job row', async () => {
    const now = await plan(sql`SELECT * FROM pipeline_run_step_durations`);
    expect(now).not.toContain('SubPlan');
    expect(await plan(LEGACY_VIEW)).toContain('SubPlan');
  });

  // criteria 17
  it('returns the same rows, columns and figures as the 0177 view', async () => {
    await expectViewMatchesLegacy(harness.db);
  });
});
