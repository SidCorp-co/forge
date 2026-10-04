// cm:why the world every runs-standing integration file stands on (ISS-108, ISS-109): one project with a member,
// a viewer and a paired box running its master, and the routes each lane writes its rows through. Bindings are
// live, so a test file reads the ids its own beforeEach wrote

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  bindTestRunner,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from './index.js';

// biome-ignore lint/suspicious/noExplicitAny: a route answer read field by field in assertions
export type Json = Record<string, any>;

export let harness: TestDatabase;
export let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
export let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
export let acquireDeployLocks: typeof import('../../src/pipeline/deploy-lock.js').acquireDeployLocks;

export let ownerId: string;
export let memberId: string;
export let projectId: string;
export let deviceId: string;
export let masterId: string;
export let box: Record<string, string>;
export let member: Record<string, string>;
export let reader: Record<string, string>;

export function registerRunsWorld(): void {
  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    ({ app } = (await import('../../src/index.js')) as unknown as { app: typeof app });
    ({ signUserToken } = await import('../../src/auth/jwt.js'));
    ({ acquireDeployLocks } = await import('../../src/pipeline/deploy-lock.js'));
  }, 60_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
    ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
    projectId = (await createTestProject(harness.db, ownerId)).id;
    memberId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
    await harness.db.execute(sql`UPDATE users SET display_name = 'Lan' WHERE id = ${memberId}`);
    await createTestProjectMember(harness.db, { userId: memberId, projectId });
    member = {
      Authorization: `Bearer ${await signUserToken(memberId)}`,
      'Content-Type': 'application/json',
    };
    const readerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
    await createTestProjectMember(harness.db, { userId: readerId, projectId, role: 'viewer' });
    reader = { Authorization: `Bearer ${await signUserToken(readerId)}` };
    const { pairDevice } = await import('./pair-device.js');
    const issued = await pairDevice({ ownerId, name: 'runs-box', platform: 'linux' });
    deviceId = issued.device.id;
    await harness.db.execute(
      sql`UPDATE devices SET agent_version = '0.18.0', last_seen_at = now() WHERE id = ${deviceId}`,
    );
    await bindTestRunner(harness.db, { projectId, deviceId });
    box = { Authorization: `Bearer ${issued.plaintext}`, 'Content-Type': 'application/json' };
    const reg = await post('/api/devices/me/master-session', {
      projectId,
      name: 'master-runs',
      maxJobPanes: 3,
    });
    expect(reg.status, JSON.stringify(reg.body)).toBe(200);
    masterId = String(reg.body.sessionId);
  });
}

export async function post(path: string, body: unknown, headers = box) {
  const res = await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Json };
}

export async function list(scope = 'all', headers: Record<string, string> = member): Promise<Json> {
  const res = await app.request(`/api/projects/${projectId}/runs/standing?scope=${scope}`, {
    headers,
  });
  expect(res.status, 'a project member reads the runs standing').toBe(200);
  return (await res.json()) as Json;
}

export async function one(runId: string, headers: Record<string, string> = member): Promise<Json> {
  const res = await app.request(`/api/projects/${projectId}/runs/standing/${runId}`, { headers });
  expect(res.status, `run ${runId} reads back`).toBe(200);
  return ((await res.json()) as Json).run as Json;
}

export async function issue(seq: number, status = 'open'): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId})`);
  return id;
}

export async function jobRun(
  issueId: string,
  job: {
    status: string;
    heldBy?: string;
    payload?: unknown;
    device?: boolean;
    sessionFailure?: string;
  },
  runStatus = 'running',
): Promise<{ runId: string; jobId: string }> {
  const runId = randomUUID();
  const jobId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, finished_at)
    VALUES (${runId}, ${projectId}, ${issueId}, 'issue', ${runStatus},
            ${runStatus === 'running' ? null : new Date().toISOString()}::timestamptz)`);
  let sessionId: string | null = null;
  if (job.sessionFailure) {
    sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, kind, status, failure_reason)
      VALUES (${sessionId}, ${projectId}, ${runId}, 'pipeline', 'failed', ${job.sessionFailure})`);
  }
  await harness.db.execute(sql`
    INSERT INTO jobs (id, project_id, issue_id, pipeline_run_id, type, status, created_by, device_id,
                      held_by, held_at, payload, agent_session_id, dispatched_at)
    VALUES (${jobId}, ${projectId}, ${issueId}, ${runId}, 'code', ${job.status}, ${ownerId},
            ${job.device ? deviceId : null}, ${job.heldBy ?? null},
            ${job.heldBy ? new Date().toISOString() : null}::timestamptz,
            ${JSON.stringify(job.payload ?? {})}::jsonb, ${sessionId},
            ${job.device ? new Date().toISOString() : null}::timestamptz)`);
  return { runId, jobId };
}

export async function openRun(seq: number, name = `ISS-${seq}`) {
  const res = await post('/api/devices/me/run-sessions', {
    projectId,
    runId: randomUUID(),
    issueKeys: [`ISS-${seq}`],
    name,
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return { sessionId: String(res.body.sessionId), runId: String(res.body.runId) };
}
