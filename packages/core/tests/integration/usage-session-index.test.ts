import { type SQL, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSessions, jobs as jobsTable, usageRecords } from '../../src/db/schema.js';
import { canonicalSessionId, usageSessionMatch } from '../../src/usage-records/rollup.js';
import {
  setupTestDatabase,
  type TestDatabase,
  type TestDb,
  truncateAll,
} from '../helpers/index.js';
import {
  expectIndexServed,
  explain,
  issueId,
  runId,
  SESSIONS,
  seedFixture,
  seedOwnerProject,
  sessionId,
  USAGE_ROWS,
} from './usage-session-ground.js';

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
  expect(Number(shapes?.positive_duration)).toBeGreaterThan(0);
}

/** What `constraintRefusing` answers for a write the database accepted. */
const ACCEPTED = 'accepted';

/**
 * The name of the constraint that refused `query`, or ACCEPTED if nothing did.
 *
 * The constraint name is on the DRIVER error, not on the wrapper drizzle throws,
 * so read it rather than matching the wrapper's message — which names the query
 * and would match a syntax error just as happily.
 */
async function constraintRefusing(db: TestDb, query: ReturnType<typeof sql>): Promise<string> {
  try {
    await db.execute(query);
    return ACCEPTED;
  } catch (err) {
    const cause = (err as { cause?: { constraint_name?: string; constraint?: string } }).cause;
    return (
      cause?.constraint_name ?? cause?.constraint ?? `refused, not by a constraint: ${String(err)}`
    );
  }
}

/**
 * The real `/api/agent-sessions` router, mounted so criterion 8 can be judged at
 * the route rather than at a predicate this file rebuilds. Module level for the
 * per-function line budget, like the 0177 view body above.
 */
async function mountAgentSessions(
  url: string,
  userId: string,
): Promise<{
  app: Hono;
  token: string;
  issueContextPeakQuery: (issueId: string) => SQL;
}> {
  process.env.DATABASE_URL = url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const { agentSessionRoutes } = await import('../../src/agent-sessions/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  const { signUserToken } = await import('../../src/auth/jwt.js');
  // Same reason as the router: session-resume pulls in db/client, which validates
  // DATABASE_URL at import. Taken here so the index case explains the query the
  // production function runs rather than a copy that cannot observe a regression.
  const { issueContextPeakQuery } = await import('../../src/jobs/session-resume.js');

  const app = new Hono();
  app.use('*', requestId());
  app.route('/api/agent-sessions', agentSessionRoutes);
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  return { app, token: await signUserToken(userId), issueContextPeakQuery };
}

interface SessionCostBody {
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  sampleCount: number;
  models: { model: string; cost: number; requests: number }[];
}

/** GET /api/agent-sessions/:id/cost through the mounted router, as a client sees it. */
async function readSessionCost(app: Hono, token: string, id: string): Promise<SessionCostBody> {
  const res = await app.request(`/api/agent-sessions/${id}/cost`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status, `GET /api/agent-sessions/${id}/cost`).toBe(200);
  return (await res.json()) as SessionCostBody;
}

describe('ISS-1015 · usage_records rollups are index-served', () => {
  let harness: TestDatabase;
  let projectId: string;
  let app: Hono;
  let ownerToken: string;
  let issueContextPeakQuery: (issueId: string) => SQL;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    await truncateAll(harness.db);
    const owner = await seedOwnerProject(harness.db);
    projectId = owner.projectId;
    await seedFixture(harness.db, projectId, owner.userId);
    ({
      app,
      token: ownerToken,
      issueContextPeakQuery,
    } = await mountAgentSessions(harness.url, owner.userId));
  }, 600_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  const plan = (query: ReturnType<typeof sql>) => explain(harness.db, query);

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

  // Not a criterion — the extra fix declared in the correction of 2026-09-17:
  // estimateIssueContextTokens (jobs/session-resume.ts) is a ninth session-scoped
  // read this issue's call-site sweep missed, because it builds raw SQL rather
  // than going through usageSessionMatch. It runs on every dispatch. The query
  // comes from that module, so restoring the old predicate THERE fails here.
  it('serves the issue context-token peak from the index', async () => {
    expectIndexServed(await plan(issueContextPeakQuery(issueId(7))));
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

  it('answers GET /api/agent-sessions/:id/cost identically for an uppercase id', async () => {
    const lower = sessionId(4_242);
    const upper = lower.toUpperCase();
    expect(upper).not.toBe(lower);

    const get = (id: string) => readSessionCost(app, ownerToken, id);

    const lowerBody = await get(lower);
    expect(lowerBody.sampleCount).toBeGreaterThan(0);
    expect(lowerBody.models.length).toBeGreaterThan(0);

    const upperBody = await get(upper);
    // `sessionId` echoes the spelling the caller used, which is not a figure.
    expect({ ...upperBody, sessionId: undefined }).toEqual({
      ...lowerBody,
      sessionId: undefined,
    });
  });

  // criteria 13
  it('refuses a session_id that is neither null nor a canonical lowercase uuid', async () => {
    const refusedBy = (query: ReturnType<typeof sql>) => constraintRefusing(harness.db, query);
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
