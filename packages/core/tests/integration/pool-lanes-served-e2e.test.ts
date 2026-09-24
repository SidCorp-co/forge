/**
 * The lanes that carry a prompt — manual enqueue, reconcile, verify_skill and
 * the escalation fallback — each minted by its own door and walked through the
 * job pool against a real Postgres: listed, prepared with that lane's prompt,
 * started, and ended by the box's fail report.
 */

import { randomUUID } from 'node:crypto';
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
import {
  type PoolBox,
  seedIssue,
  seedPoolBox,
  walkThroughPool,
} from '../helpers/pool-lanes-fixture.js';

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let userToken: string;
let m: {
  readPool: typeof import('../../src/devices/pool.js').readPool;
  prepare: typeof import('../../src/devices/claim.js').prepareJobForMaster;
  start: typeof import('../../src/devices/claim.js').startJobForMaster;
  spawnReconcileRun: typeof import('../../src/skills/reconcile-service.js').spawnReconcileRun;
  recordReconcileVerdict: typeof import('../../src/skills/reconcile-service.js').recordReconcileVerdict;
  runPmEscalationSweep: typeof import('../../src/pm/escalation-sweeper.js').runPmEscalationSweep;
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  await registerIntegrationsForTest();
  const pool = await import('../../src/devices/pool.js');
  const claim = await import('../../src/devices/claim.js');
  const reconcile = await import('../../src/skills/reconcile-service.js');
  const escalation = await import('../../src/pm/escalation-sweeper.js');
  const jwt = await import('../../src/auth/jwt.js');
  m = {
    readPool: pool.readPool,
    prepare: claim.prepareJobForMaster,
    start: claim.startJobForMaster,
    spawnReconcileRun: reconcile.spawnReconcileRun,
    recordReconcileVerdict: reconcile.recordReconcileVerdict,
    runPmEscalationSweep: escalation.runPmEscalationSweep,
    signUserToken: jwt.signUserToken,
  };
  const { jobProjectRoutes } = await import('../../src/jobs/routes.js');
  const { jobLifecycleDeviceRoutes } = await import('../../src/jobs/lifecycle-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/projects', jobProjectRoutes as never);
  app.route('/api/jobs', jobLifecycleDeviceRoutes as never);
  app.onError(errorHandler);
}, 120_000);

let box: PoolBox;
let ownerId: string;
let projectId: string;
let deviceId: string;
const issueRow = () => seedIssue(harness, box);

beforeEach(async () => {
  await truncateAll(harness.db);
  box = await seedPoolBox(harness);
  ({ ownerId, projectId, deviceId } = box);
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

const walk = (jobId: string, prompt: string, opts?: { resumed?: boolean }) =>
  walkThroughPool(
    harness,
    box,
    {
      readPool: m.readPool,
      prepare: m.prepare,
      start: m.start,
      request: (p, i) => app.request(p, i),
    },
    jobId,
    prompt,
    opts,
  );

describe('lanes that carry a prompt are claimed and finished through the pool', () => {
  it('manual enqueue', async () => {
    const res = await userPost(`/api/projects/${projectId}/jobs`, {
      type: 'custom',
      payload: { promptString: 'do the manual thing' },
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    await walk(id, 'do the manual thing');
  });

  async function reconcileFixture(): Promise<{ packetId: string; skillId: string }> {
    const packetId = randomUUID();
    const skillId = randomUUID();
    const hash = `sha-${randomUUID()}`;
    await harness.db.execute(sql`
      INSERT INTO update_packets (id, change, story, intent_class, applies_to)
      VALUES (${packetId}, 'tighten the rule', 'a person asked for it', 'procedure', 'forge-code')
    `);
    await harness.db.execute(sql`
      INSERT INTO skills (id, name, description, scope, project_id, prompt, source, content_hash, skill_md)
      VALUES (${skillId}, 'forge-code', 'the code step', 'project', ${projectId}, 'body', 'user',
              ${hash}, 'running body')
    `);
    for (const agent of ['forge-reconcile', 'forge-verify-skill']) {
      await harness.db.execute(sql`
        INSERT INTO skills (name, description, scope, prompt, source, content_hash, skill_md)
        VALUES (${agent}, 'agent instructions', 'global', ${`${agent} body`}, 'builtin',
                ${`sha-${agent}`}, ${`${agent} instructions`})
      `);
    }
    await harness.db.execute(sql`
      INSERT INTO device_skills (device_id, project_id, skill_id, installed_hash, synced_at, observed_sha)
      VALUES (${deviceId}, ${projectId}, ${skillId}, ${hash}, now(), ${hash})
    `);
    return { packetId, skillId };
  }

  async function spawnReconcile(): Promise<{ runId: string; jobId: string; prompt: string }> {
    const fx = await reconcileFixture();
    const spawned = await m.spawnReconcileRun({ projectId, ...fx, actorUserId: ownerId });
    expect(spawned, JSON.stringify(spawned)).toMatchObject({ ok: true });
    if (!spawned.ok) throw new Error('reconcile did not spawn');
    const rows = (await harness.db.execute(sql`
      SELECT id, payload->>'promptString' AS prompt FROM jobs
      WHERE project_id = ${projectId} AND type = 'reconcile'
    `)) as unknown as Array<{ id: string; prompt: string }>;
    const row = rows[0];
    if (!row) throw new Error('no reconcile job minted');
    return { runId: spawned.runId, jobId: row.id, prompt: row.prompt };
  }

  it('reconcile', async () => {
    const { jobId, prompt } = await spawnReconcile();
    expect(prompt.trim().length).toBeGreaterThan(0);
    await walk(jobId, prompt);
  });

  it('verify_skill', async () => {
    const { runId } = await spawnReconcile();
    await m.recordReconcileVerdict({
      runId,
      verdict: 'apply',
      candidateBody: 'the candidate body',
      rationale: 'measured',
      gate: 'auto',
      actor: 'agent:test',
    });
    const rows = (await harness.db.execute(sql`
      SELECT id, payload->>'promptString' AS prompt FROM jobs
      WHERE project_id = ${projectId} AND type = 'verify_skill'
    `)) as unknown as Array<{ id: string; prompt: string }>;
    expect(rows.length, 'a recorded verdict mints the verifier jobs').toBeGreaterThan(0);
    const first = rows[0];
    if (!first) return;
    expect(first.prompt.trim().length).toBeGreaterThan(0);
    await walk(first.id, first.prompt);
  });

  it('escalation fallback', async () => {
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
    expect(swept.executed).toBe(1);
    const rows = (await harness.db.execute(sql`
      SELECT id, payload->>'promptString' AS prompt FROM jobs
      WHERE project_id = ${projectId} AND issue_id = ${issueId}
    `)) as unknown as Array<{ id: string; prompt: string }>;
    const row = rows[0];
    if (!row) throw new Error('the sweeper minted no job');
    expect(row.prompt.trim().length).toBeGreaterThan(0);
    await walk(row.id, row.prompt);
  });
});
