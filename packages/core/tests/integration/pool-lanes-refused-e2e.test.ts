/**
 * The lanes the job pool cannot brief — PM spawn, enrich, and a manual job with
 * no prompt — refused by name at their doors, against a real Postgres. The pool
 * runs only the `payload.promptString` a job is minted with, so a lane that
 * mints none is refused where it would mint.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  registerIntegrationsForTest,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { countRows, type PoolBox, seedIssue, seedPoolBox } from '../helpers/pool-lanes-fixture.js';

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let userToken: string;
let m: {
  runPmEscalationSweep: typeof import('../../src/pm/escalation-sweeper.js').runPmEscalationSweep;
  spawnPmSession: typeof import('../../src/pm/spawner.js').spawnPmSession;
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  const pm = await import('../../src/pm/spawner.js');
  const jwt = await import('../../src/auth/jwt.js');
  const escalation = await import('../../src/pm/escalation-sweeper.js');
  m = {
    runPmEscalationSweep: escalation.runPmEscalationSweep,
    spawnPmSession: pm.spawnPmSession,
    signUserToken: jwt.signUserToken,
  };
  const { jobProjectRoutes } = await import('../../src/jobs/routes.js');
  const { issueExtrasRoutes } = await import('../../src/issues/extras-routes.js');
  const { pmRoutes } = await import('../../src/pm/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', jobProjectRoutes as never);
  app.route('/api/projects', pmRoutes as never);
  app.route('/api/issues', issueExtrasRoutes as never);
  app.onError(errorHandler);
}, 120_000);

let box: PoolBox;
let ownerId: string;
let projectId: string;
const count = (table: 'jobs' | 'pipeline_runs') => countRows(harness, projectId, table);
const issueRow = () => seedIssue(harness, box);

beforeEach(async () => {
  await truncateAll(harness.db);
  box = await seedPoolBox(harness);
  ({ ownerId, projectId } = box);
  userToken = await m.signUserToken(ownerId);
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

function userPost(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('lanes the pool cannot brief are refused by name', () => {
  async function enablePm(overrides: { maxRunsPerHour?: number; triggers?: object } = {}) {
    await harness.db.execute(sql`
      INSERT INTO pm_config (project_id, enabled, max_runs_per_hour, event_triggers)
      VALUES (${projectId}, true, ${overrides.maxRunsPerHour ?? 6},
              ${JSON.stringify(overrides.triggers ?? { jobFailed: true, graphChanged: true })}::jsonb)
    `);
  }

  it('a PM spawn that passes every guard mints nothing and answers pool-job-no-prompt', async () => {
    await enablePm();
    const result = await m.spawnPmSession({ projectId, cause: 'tick' });
    expect(result).toEqual({ ok: false, reason: 'pool-job-no-prompt' });
    expect(await count('jobs')).toBe(0);
    expect(await count('pipeline_runs')).toBe(0);
  });

  it('a PM spawn a guard refuses keeps that guard as its answer', async () => {
    expect(await m.spawnPmSession({ projectId, cause: 'tick' })).toEqual({
      ok: false,
      reason: 'disabled',
    });
    await enablePm({ triggers: { jobFailed: false }, maxRunsPerHour: 0 });
    expect(await m.spawnPmSession({ projectId, cause: 'job-failed' })).toEqual({
      ok: false,
      reason: 'trigger-masked',
    });
    expect(await m.spawnPmSession({ projectId, cause: 'tick' })).toEqual({
      ok: false,
      reason: 'rate-limited',
    });
    expect(await count('jobs')).toBe(0);
  });

  it('the operator PM run answers 422 POOL_JOB_NO_PROMPT', async () => {
    await enablePm({ maxRunsPerHour: 0 });
    const res = await userPost(`/api/projects/${projectId}/pm/run`, {});
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('POOL_JOB_NO_PROMPT');
    expect(await count('jobs')).toBe(0);
  });

  it('enrich answers 422 POOL_JOB_NO_PROMPT and opens neither a job nor a run', async () => {
    const issueId = await issueRow();
    const res = await userPost(`/api/issues/${issueId}/enrich`, {});
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('POOL_JOB_NO_PROMPT');
    expect(await count('jobs')).toBe(0);
    expect(await count('pipeline_runs')).toBe(0);
  });

  it.each([
    ['missing', {}],
    ['empty', { promptString: '' }],
    ['whitespace-only', { promptString: '   \n\t ' }],
    ['not a string', { promptString: 42 }],
  ])('a manual job whose prompt is %s answers 422 and mints nothing', async (_label, payload) => {
    const res = await userPost(`/api/projects/${projectId}/jobs`, { type: 'custom', payload });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('POOL_JOB_NO_PROMPT');
    expect(await count('jobs')).toBe(0);
    expect(await count('pipeline_runs')).toBe(0);
  });

  it('an expired escalation whose fallback names a retired staged type is skipped by name and mints nothing', async () => {
    const issueId = await issueRow();
    await harness.db.execute(sql`
      INSERT INTO pm_decisions (project_id, cause, summary, event_ref, actions)
      VALUES (${projectId}, 'tick', 'escalated',
              ${JSON.stringify({ expiresAt: new Date(Date.now() - 60_000).toISOString() })}::jsonb,
              ${JSON.stringify([
                {
                  type: 'escalate',
                  fallback: { type: 'dispatch', issueId, jobType: 'code', payload: {} },
                },
              ])}::jsonb)
    `);
    const swept = await m.runPmEscalationSweep();
    expect(swept).toMatchObject({ executed: 0, skipped: 1, errors: 0 });
    expect(await count('jobs')).toBe(0);
    const recorded = (await harness.db.execute(sql`
      SELECT event_ref->'fallbackOutcomes' AS outcomes FROM pm_decisions
      WHERE project_id = ${projectId} AND cause = 'escalation-timeout'
    `)) as unknown as Array<{ outcomes: Array<{ status: string; reason?: string }> }>;
    expect(recorded[0]?.outcomes).toEqual([
      { type: 'dispatch', status: 'skipped', reason: 'retired_job_type' },
    ]);
  });

  it.each(['triage', 'clarify', 'plan', 'code', 'review', 'test', 'staging', 'release', 'fix'])(
    'a manual job of the retired staged type %s answers 400 naming it and mints nothing',
    async (type) => {
      const res = await userPost(`/api/projects/${projectId}/jobs`, {
        type,
        payload: { promptString: 'run the old stage' },
      });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain(
        `job type '${type}' was a stage of the staged pipeline and is retired`,
      );
      expect(body).toContain('custom, pm, smoke, release_batch, reconcile, verify_skill, drive');
      expect(await count('jobs')).toBe(0);
      expect(await count('pipeline_runs')).toBe(0);
    },
  );
});
