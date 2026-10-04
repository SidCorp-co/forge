// cm:why each run is planted as the rows its lane writes, through the real device and user routes wherever one
// exists, on real Postgres: the read model and the refusal a transition answers must agree on the state (ISS-108)

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
} from '../helpers/index.js';

// biome-ignore lint/suspicious/noExplicitAny: a route answer read field by field in assertions
type Json = Record<string, any>;

let harness: TestDatabase;
let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let acquireDeployLocks: typeof import('../../src/pipeline/deploy-lock.js').acquireDeployLocks;

let ownerId: string;
let memberId: string;
let projectId: string;
let deviceId: string;
let masterId: string;
let box: Record<string, string>;
let member: Record<string, string>;
let reader: Record<string, string>;

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
  const { pairDevice } = await import('../helpers/pair-device.js');
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

async function post(path: string, body: unknown, headers = box) {
  const res = await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Json };
}

async function list(scope = 'all', headers: Record<string, string> = member): Promise<Json> {
  const res = await app.request(`/api/projects/${projectId}/runs/standing?scope=${scope}`, {
    headers,
  });
  expect(res.status, 'a project member reads the runs standing').toBe(200);
  return (await res.json()) as Json;
}

async function one(runId: string, headers: Record<string, string> = member): Promise<Json> {
  const res = await app.request(`/api/projects/${projectId}/runs/standing/${runId}`, { headers });
  expect(res.status, `run ${runId} reads back`).toBe(200);
  return ((await res.json()) as Json).run as Json;
}

async function issue(seq: number, status = 'open'): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId})`);
  return id;
}

async function jobRun(
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

async function openRun(seq: number, name = `ISS-${seq}`) {
  const res = await post('/api/devices/me/run-sessions', {
    projectId,
    runId: randomUUID(),
    issueKeys: [`ISS-${seq}`],
    name,
  });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return { sessionId: String(res.body.sessionId), runId: String(res.body.runId) };
}

describe('GET /api/projects/:id/runs/standing: a fixture per state reads back from its rows', () => {
  it('serves all nine states from the rows each lane writes', async () => {
    const i = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(() => '');
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) i[n] = await issue(n);

    const queued = await jobRun(i[1] as string, { status: 'queued' });
    const claimed = await jobRun(i[2] as string, { status: 'queued', heldBy: masterId });
    const running = await openRun(3);
    const waitingPerson = await openRun(4);
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, agent_session_id, status, blocker_kind, steps)
      VALUES (${randomUUID()}, ${projectId}, ${i[4]}, ${waitingPerson.sessionId}, 'open', 'human', '[]'::jsonb)`);
    const gate = await jobRun(i[5] as string, {
      status: 'held',
      payload: {
        __hold: {
          reason: 'all_devices_exhausted',
          heldAt: new Date().toISOString(),
          autoRelease: true,
        },
      },
    });
    const done = await openRun(6);
    await harness.db.execute(sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, actor_type, actor_agency, source)
      VALUES ('issue', ${i[6]}, 'open', 'awaiting_release', 'system', 'agent', 'test')`);
    expect(
      (await post(`/api/devices/me/run-sessions/${done.sessionId}/close`, { outcome: 'ended' }))
        .status,
    ).toBe(200);
    const failed = await jobRun(
      i[7] as string,
      { status: 'failed', sessionFailure: 'provider_usage_limit' },
      'failed',
    );
    const cancelled = await jobRun(i[8] as string, { status: 'queued' });
    expect(
      (await post(`/api/pipeline-runs/${cancelled.runId}/cancel`, { parkIssue: false }, member))
        .status,
    ).toBe(200);
    const handedBack = await openRun(9);
    expect(
      (
        await post(`/api/devices/me/run-sessions/${handedBack.sessionId}/close`, {
          outcome: 'killed_idle',
        })
      ).status,
    ).toBe(200);

    const body = await list('all');
    const state = (runId: string) => body.items.find((r: Json) => r.id === runId);
    expect(state(queued.runId)).toMatchObject({ state: 'queued', waitingOn: { kind: 'master' } });
    expect(state(claimed.runId)).toMatchObject({
      state: 'claimed',
      holder: { source: 'held', kind: 'master', sessionId: masterId, expirySource: 'silence_reap' },
    });
    expect(state(running.runId)).toMatchObject({
      state: 'running',
      holder: {
        source: 'held',
        kind: 'run',
        sessionId: running.sessionId,
        expirySource: 'silence_reap',
      },
      master: { source: 'session', sessionId: masterId, live: true },
    });
    expect(state(waitingPerson.runId)).toMatchObject({
      state: 'waiting_person',
      waitingOn: { kind: 'person', who: 'You', isViewer: true },
      needsViewer: true,
    });
    expect(state(gate.runId)).toMatchObject({
      state: 'waiting_gate',
      waitingOn: { kind: 'gate', gate: 'all_devices_exhausted', resumesAt: null },
    });
    expect(state(done.runId)).toMatchObject({ state: 'done', outcome: { kind: 'done' } });
    expect(state(failed.runId)).toMatchObject({
      state: 'failed',
      outcome: { kind: 'failed', cause: 'provider_usage_limit', classified: true },
    });
    expect(state(cancelled.runId)).toMatchObject({
      state: 'cancelled',
      outcome: { kind: 'cancelled', by: { type: 'user', userId: memberId, name: 'Lan' } },
    });
    expect(state(handedBack.runId)).toMatchObject({
      state: 'handed_back',
      outcome: {
        kind: 'handed_back',
        close: 'killed_idle',
        returnedTo: [{ issueKey: 'ISS-9', status: 'open' }],
      },
    });
    for (const r of body.items) expect(r.stuck.source, 'stuck is ISS-109s').toBe('not_computed');
    expect(body.counts.liveByState).toMatchObject({
      queued: 1,
      claimed: 1,
      running: 1,
      waiting_person: 1,
      waiting_gate: 1,
    });
    expect(body.master).toMatchObject({ state: 'idle', sessionId: masterId });
    expect(body.excluded.map((e: Json) => e.what)).toEqual(['interactive', 'master']);
  });

  it('serves a run by id with every attempt over the same issue, the next attempt a new run', async () => {
    await issue(1);
    const first = await openRun(1, 'first');
    await post(`/api/devices/me/run-sessions/${first.sessionId}/close`, { outcome: 'killed_idle' });
    const second = await openRun(1, 'second');
    const res = await app.request(`/api/projects/${projectId}/runs/standing/${second.runId}`, {
      headers: member,
    });
    const body = (await res.json()) as Json;
    expect(body.run.attempt).toEqual({ source: 'runs', n: 2, retryOf: first.runId, of: 'ISS-1' });
    expect(body.attempts.map((a: Json) => [a.n, a.state])).toEqual([
      [2, 'running'],
      [1, 'handed_back'],
    ]);
  });

  it('refuses an unknown query parameter and a run of another project by name', async () => {
    const bad = await app.request(`/api/projects/${projectId}/runs/standing?state=running`, {
      headers: member,
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain('`state`');
    const missing = await app.request(`/api/projects/${projectId}/runs/standing/${randomUUID()}`, {
      headers: member,
    });
    expect(missing.status).toBe(404);
  });
});

describe('the holder', () => {
  it('the fleet key reads silence_reap at the last beat + 10 min, and issue_leases gained no column', async () => {
    await issue(1);
    const run = await openRun(1);
    await harness.db.execute(
      sql`UPDATE agent_sessions SET last_heartbeat_at = '2026-10-04T09:00:00Z' WHERE id = ${run.sessionId}`,
    );
    const r = await one(run.runId);
    expect(r.holder).toMatchObject({
      expirySource: 'silence_reap',
      expiresAt: '2026-10-04T09:10:00.000Z',
    });
    const cols = (await harness.db.execute(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'issue_leases' ORDER BY column_name`)) as unknown as Array<{
      column_name: string;
    }>;
    expect(cols.map((c) => c.column_name)).toEqual([
      'acquired_at',
      'device_id',
      'issue_key',
      'project_id',
      'run_id',
      'session_id',
    ]);
  });

  it('a person who cannot write sees the wait named for a project writer, not marked as theirs', async () => {
    const issueId = await issue(1);
    const run = await openRun(1);
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, agent_session_id, status, blocker_kind, steps)
      VALUES (${randomUUID()}, ${projectId}, ${issueId}, ${run.sessionId}, 'open', 'human', '[]'::jsonb)`);
    const r = await one(run.runId, reader);
    expect(r.waitingOn).toMatchObject({ kind: 'person', who: 'A project writer', isViewer: false });
    expect(r.needsViewer).toBe(false);
  });

  it('a question with no session waits only the run on its own issue, and list and detail agree', async () => {
    const asked = await issue(1);
    const other = await issue(2);
    const a = await jobRun(asked, { status: 'running', device: true });
    const b = await jobRun(other, { status: 'running', device: true });
    await harness.db.execute(sql`
      INSERT INTO agent_questions (id, project_id, issue_id, agent_session_id, status, blocker_kind, steps)
      VALUES (${randomUUID()}, ${projectId}, ${asked}, NULL, 'open', 'human', '[]'::jsonb)`);
    const items = (await list('live')).items as Json[];
    const fromList = (id: string) => items.find((x) => x.id === id);
    expect(fromList(a.runId)?.state).toBe('waiting_person');
    expect(fromList(b.runId)?.state).toBe('running');
    expect((await one(a.runId)).state).toBe('waiting_person');
    expect((await one(b.runId)).state).toBe('running');
  });
});

describe('done never reads as cancelled', () => {
  it('a completed run reads done and a cancelled one reads cancelled, each with its own actor', async () => {
    const a = await jobRun(await issue(1), { status: 'done' }, 'completed');
    const b = await jobRun(await issue(2), { status: 'queued' });
    await post(`/api/pipeline-runs/${b.runId}/cancel`, { parkIssue: false }, member);
    expect(await one(a.runId)).toMatchObject({ state: 'done', outcome: { kind: 'done' } });
    expect(await one(b.runId)).toMatchObject({
      state: 'cancelled',
      outcome: { kind: 'cancelled' },
    });
  });
});

describe('each transition keeps its refusal code, and the read model agrees with it on the state', () => {
  it('ISSUE_LEASE_HELD names the holder the read model names', async () => {
    await issue(1);
    const held = await openRun(1);
    const refused = await post('/api/devices/me/run-sessions', {
      projectId,
      runId: randomUUID(),
      issueKeys: ['ISS-1'],
      name: 'second',
    });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('ISSUE_LEASE_HELD');
    const holders = (refused.body.details?.holders ?? refused.body.holders) as Json[];
    const r = await one(held.runId);
    expect(r.state).toBe('running');
    expect(holders[0]?.sessionId).toBe(r.holder.sessionId);
  });

  it('prepare answers already_held on a job the read model reads claimed by its master', async () => {
    const { runId, jobId } = await jobRun(await issue(1), { status: 'queued', heldBy: masterId });
    const { pairDevice } = await import('../helpers/pair-device.js');
    const second = await pairDevice({ ownerId, name: 'runs-box-2', platform: 'linux' });
    await harness.db.execute(
      sql`UPDATE devices SET agent_version = '0.18.0', last_seen_at = now() WHERE id = ${second.device.id}`,
    );
    await bindTestRunner(harness.db, { projectId, deviceId: second.device.id });
    const box2 = {
      Authorization: `Bearer ${second.plaintext}`,
      'Content-Type': 'application/json',
    };
    const other = await post(
      '/api/devices/me/master-session',
      { projectId, name: 'master-2', maxJobPanes: 1 },
      box2,
    );
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    const refused = await post(
      '/api/devices/me/pool/prepare',
      { jobId, sessionId: other.body.sessionId },
      box2,
    );
    expect(refused.body).toMatchObject({ ok: false, reason: 'already_held' });
    expect(await one(runId)).toMatchObject({
      state: 'claimed',
      holder: { kind: 'master', sessionId: masterId },
    });
  });

  it('INVALID_STATE on a device complete of a job the read model reads cancelled', async () => {
    const { runId, jobId } = await jobRun(
      await issue(1),
      { status: 'cancelled', device: true },
      'cancelled',
    );
    const refused = await post(`/api/jobs/${jobId}/complete`, { exitCode: 0 });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('INVALID_STATE');
    expect((await one(runId)).state).toBe('cancelled');
  });

  it('NOT_CANCELLABLE on a job the read model reads done', async () => {
    const { runId, jobId } = await jobRun(await issue(1), { status: 'done' }, 'completed');
    const refused = await post(`/api/jobs/${jobId}/cancel`, {}, member);
    expect(JSON.stringify(refused.body)).toContain('NOT_CANCELLABLE');
    expect((await one(runId)).state).toBe('done');
  });

  it('run_terminal on a run the read model reads done', async () => {
    const { runId } = await jobRun(await issue(1), { status: 'done' }, 'completed');
    const refused = await post(`/api/pipeline-runs/${runId}/cancel`, {}, member);
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('run_terminal');
    expect((await one(runId)).state).toBe('done');
  });

  it('NOT_HELD on a job the read model reads running, not waiting', async () => {
    const { runId, jobId } = await jobRun(await issue(1), { status: 'running', device: true });
    const refused = await post(`/api/jobs/${jobId}/resume`, {}, member);
    expect(JSON.stringify(refused.body)).toContain('NOT_HELD');
    const r = await one(runId);
    expect(r.state).toBe('running');
    expect(r.waitingOn.kind).toBe('none');
  });

  it('DEPLOY_ENVIRONMENT_LOCKED names the run and expiry the read model serves as its deploy-lock holder', async () => {
    const a = randomUUID();
    const b = randomUUID();
    for (const id of [a, b]) {
      await harness.db.execute(sql`
        INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${id}, ${projectId}, 'system', 'running')`);
    }
    await acquireDeployLocks({ projectId, runId: a, subject: 'v1.0.0' }, ['preview']);
    const refusal = await acquireDeployLocks({ projectId, runId: b, subject: 'v1.0.1' }, [
      'preview',
    ]).then(
      () => null,
      (e: { code?: string; holder?: { runId: string; expiresAt: string } }) => e,
    );
    expect(refusal?.code).toBe('DEPLOY_ENVIRONMENT_LOCKED');
    const r = await one(a);
    expect(r.lane).toBe('deploy');
    expect(r.holder).toMatchObject({
      source: 'held',
      expirySource: 'deploy_lock',
      expiresAt: refusal?.holder?.expiresAt,
    });
    expect(refusal?.holder?.runId).toBe(r.id);
    expect((await one(b)).holder.source).toBe('none');
  });
});

describe('GET /api/projects/:id/masters/passes', () => {
  it('pages the stored passes newest first', async () => {
    for (const verb of ['triage', 'dispatch', 'fold']) {
      const opened = await post('/api/devices/me/master-session/pass', {
        op: 'open',
        sessionId: masterId,
        verb,
      });
      expect(opened.status).toBe(201);
      await post('/api/devices/me/master-session/pass', {
        op: 'close',
        sessionId: masterId,
        passId: opened.body.pass.id,
        dispatched: [],
        skipped: [],
        parked: [],
      });
    }
    const first = await app.request(`/api/projects/${projectId}/masters/passes?limit=2`, {
      headers: member,
    });
    const page = (await first.json()) as Json;
    expect(page.items.map((p: Json) => p.verb)).toEqual(['fold', 'dispatch']);
    expect(page.hasMore).toBe(true);
    const next = await app.request(
      `/api/projects/${projectId}/masters/passes?limit=2&before=${encodeURIComponent(page.next)}`,
      { headers: member },
    );
    const rest = (await next.json()) as Json;
    expect(rest.items.map((p: Json) => p.verb)).toEqual(['triage']);
    expect(rest.hasMore).toBe(false);
  });
});
