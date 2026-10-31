import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
} from '../helpers/factories.js';

// REQ-12 BC-19: the fleet strip's online runners, queued count and stalled banner, and the attention
// screen's org scope, counts and offline runners are core's read models' answers, not a screen's sums.
// @direct-test-of packages/core/src/agent-sessions/ops-routes.ts
// @direct-test-of packages/core/src/agent-sessions/read.ts
// @direct-test-of packages/core/src/me/attention-routes.ts
// @direct-test-of packages/core/src/me/attention-buckets.ts

async function session(projectId: string, status: string, deviceId: string | null = null) {
  const runId = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, metadata)
    VALUES (${runId}, ${projectId}, 'system', 'running', '{}'::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO agent_sessions (project_id, device_id, pipeline_run_id, kind, status)
    VALUES (${projectId}, ${deviceId}, ${runId}, 'run_session', ${status})
  `);
}

describe('the queue and attention read models serve the derived facts', () => {
  let token = '';
  let owner = '';
  let project: { id: string; slug: string; orgId: string };
  let other: { id: string; slug: string; orgId: string };

  beforeAll(async () => {
    testEnv();
    await import('../../src/index.js');
    await startQueue();
    owner = (await createTestUser({ verified: true })).id;
    project = await createTestProject(owner);
    other = await createTestProject(owner);
    await addProjectMember(project.id, owner, 'owner');
    await addProjectMember(other.id, owner, 'owner');
    token = await userToken(owner);
  }, 180_000);

  afterAll(closeWorld);

  it('stalls dispatch when sessions wait, idle ones included, and no runner is online', async () => {
    const offline = await createTestDevice(owner, { status: 'offline', name: 'box-off' });
    await bindTestRunner(project.id, offline);
    await session(project.id, 'queued');
    await session(project.id, 'idle');
    await session(project.id, 'running');
    const res = await api(token, 'GET', `/api/agent-sessions/queue-stats?projectId=${project.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ waiting: 2, onlineRunners: 0, dispatchStalled: true });
  });

  it('is not stalled once a runner is online, and not stalled with nothing waiting', async () => {
    const online = await createTestDevice(owner, { status: 'online' });
    await bindTestRunner(project.id, online);
    const busy = await api(token, 'GET', `/api/agent-sessions/queue-stats?projectId=${project.id}`);
    expect(busy.body).toMatchObject({ waiting: 2, onlineRunners: 1, dispatchStalled: false });
    const idleProject = await api(
      token,
      'GET',
      `/api/agent-sessions/queue-stats?projectId=${other.id}`,
    );
    expect(idleProject.body).toMatchObject({
      waiting: 0,
      onlineRunners: 0,
      dispatchStalled: false,
    });
  });

  it('serves the owner offline runners and a count for every bucket', async () => {
    const res = await api(token, 'GET', '/api/me/attention');
    expect(res.status).toBe(200);
    const offline = res.body.offlineRunners as { kind: string; deviceName: string }[];
    expect(offline.map((d) => d.deviceName)).toEqual(['box-off']);
    expect(offline[0]?.kind).toBe('runner_offline');
    expect(res.body.counts).toMatchObject({ offlineRunners: 1, mentions: 0, failedJobs: 0 });
    expect(res.body.total).toBe(1);
  });

  it('keeps the device alert under any org scope', async () => {
    const res = await api(token, 'GET', `/api/me/attention?orgId=${project.orgId}`);
    expect(res.status).toBe(200);
    expect((res.body.counts as { offlineRunners: number }).offlineRunners).toBe(1);
  });

  it('refuses an orgId that is no uuid, by name', async () => {
    const res = await api(token, 'GET', '/api/me/attention?orgId=not-an-org');
    expect(res.status).toBe(400);
    const none = await api(token, 'GET', `/api/me/attention?org=${randomUUID()}`);
    expect(none.status).toBe(400);
  });
});
