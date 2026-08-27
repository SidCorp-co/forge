import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type TestResult = 'pass' | 'fail' | 'blocked_fixture' | 'verified_by_test';

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let runTimeseries: typeof import('../../src/metrics/queries.js').runTimeseries;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';

  const { stepHandoffRoutes } = await import('../../src/pipeline/step-handoff-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ({ runTimeseries } = await import('../../src/metrics/queries.js'));

  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/issue-step-contexts', stepHandoffRoutes);
  app.onError(errorHandler);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

async function createContext() {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'admin',
  });
  const issueId = randomUUID();
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, priority, created_by_id)
    VALUES (${issueId}, ${project.id}, 'test issue', 'testing', 'medium',
      (SELECT created_by FROM projects WHERE id = ${project.id}))
  `);
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, current_step)
    VALUES (${runId}, ${project.id}, ${issueId}, 'issue', 'running', 'test')
  `);
  return { projectId: project.id, issueId, runId, userToken: await signUserToken(user.id) };
}

async function writeTestHandoff(args: {
  projectId: string;
  issueId: string;
  runId: string;
  userToken: string;
  attempt: number;
  result: TestResult;
  resultReason?: string;
}) {
  return app.request('/api/issue-step-contexts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${args.userToken}` },
    body: JSON.stringify({
      projectId: args.projectId,
      issueId: args.issueId,
      pipelineRunId: args.runId,
      step: 'test',
      attempt: args.attempt,
      payload: {
        step: 'test',
        schema_version: 1,
        result: args.result,
        ...(args.resultReason ? { resultReason: args.resultReason } : {}),
        failures: [],
        flakyTests: [],
      },
    }),
  });
}

it.each(['blocked_fixture', 'verified_by_test'] as const)(
  'persists %s with its promoted verdict',
  async (result) => {
    const context = await createContext();
    const writeRes = await writeTestHandoff({
      ...context,
      attempt: 1,
      result,
      resultReason: 'Live verification could not run.',
    });
    expect(writeRes.status).toBe(201);

    const rows = await harness.db.execute(
      sql`SELECT pipeline_run_id, verdict, payload FROM issue_step_contexts WHERE issue_id = ${context.issueId}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pipeline_run_id: context.runId, verdict: result });
    expect(rows[0]?.payload).toMatchObject({
      result,
      resultReason: 'Live verification could not run.',
    });
  },
);

it.each(['blocked_fixture', 'verified_by_test'] as const)(
  'rejects %s without a result reason',
  async (result) => {
    const context = await createContext();
    const writeRes = await writeTestHandoff({ ...context, attempt: 1, result });
    expect(writeRes.status).toBe(400);
  },
);

it('counts verified-by-test as evidence and excludes fixture blocks from pass rate', async () => {
  const context = await createContext();
  const results: TestResult[] = ['pass', 'fail', 'blocked_fixture', 'verified_by_test'];
  for (const [index, result] of results.entries()) {
    const writeRes = await writeTestHandoff({
      ...context,
      attempt: index + 1,
      result,
      ...(result === 'blocked_fixture' || result === 'verified_by_test'
        ? { resultReason: 'Direct verification was unavailable.' }
        : {}),
    });
    expect(writeRes.status).toBe(201);
  }

  const out = await runTimeseries({
    projectId: context.projectId,
    metric: 'pass_rate',
    days: 1,
    bucket: 'day',
    groupByStep: false,
  });
  expect(out.series).toContainEqual(expect.objectContaining({ n: 3, rate: 2 / 3 }));
});
