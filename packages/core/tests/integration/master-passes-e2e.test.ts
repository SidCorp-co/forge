// cm:why every pass is planted through /api/devices/me/master-session/pass with a device credential, on real
// Postgres: the refusals are a partial unique index, an advisory lock and a trigger, none of which a mock can fail (ISS-106)

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

type Json = Record<string, unknown> & {
  error?: { code: string; message: string; refusals: { code: string; detail: string }[] };
};

let harness: TestDatabase;
let app: { request: (path: string, init?: RequestInit) => Promise<Response> };
let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
let reapSilentMasters: typeof import('../../src/devices/master-reaper.js').reapSilentMasters;
let openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;

let ownerId: string;
let projectId: string;
let deviceId: string;
let box: Record<string, string>;
let viewer: Record<string, string>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  ({ app } = (await import('../../src/index.js')) as unknown as { app: typeof app });
  ({ signUserToken } = await import('../../src/auth/jwt.js'));
  ({ reapSilentMasters } = await import('../../src/devices/master-reaper.js'));
  ({ openRunSession } = await import('../../src/devices/run-session.js'));
}, 60_000);

afterAll(async () => {
  await harness.cleanup();
});

async function aBox(name: string, agentVersion: string | null) {
  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({ ownerId, name, platform: 'linux' });
  await harness.db.execute(
    sql`UPDATE devices SET agent_version = ${agentVersion}, last_seen_at = now() WHERE id = ${issued.device.id}`,
  );
  await bindTestRunner(harness.db, { projectId, deviceId: issued.device.id });
  return {
    id: issued.device.id,
    auth: { Authorization: `Bearer ${issued.plaintext}`, 'Content-Type': 'application/json' },
  };
}

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  projectId = (await createTestProject(harness.db, ownerId)).id;
  const member = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  await createTestProjectMember(harness.db, { userId: member, projectId });
  viewer = { Authorization: `Bearer ${await signUserToken(member)}` };
  const b = await aBox('pass-box', '0.18.0');
  deviceId = b.id;
  box = b.auth;
});

const post = async (path: string, body: unknown, headers = box) => {
  const res = await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Json };
};

const register = (body: Record<string, unknown>, headers = box) =>
  post('/api/devices/me/master-session', { projectId, name: 'master-test', ...body }, headers);

const pass = (body: Record<string, unknown>, headers = box) =>
  post('/api/devices/me/master-session/pass', body, headers);

async function standing(): Promise<Json> {
  const res = await app.request(`/api/projects/${projectId}/masters/standing`, { headers: viewer });
  expect(res.status, 'a project member reads the master standing').toBe(200);
  return (await res.json()) as Json;
}

async function liveMaster(maxJobPanes = 3): Promise<string> {
  const reg = await register({ maxJobPanes });
  expect(reg.status).toBe(200);
  return String(reg.body.sessionId);
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const [row] = (await harness.db.execute(query)) as unknown as Array<{ n: number }>;
  return Number(row?.n ?? 0);
}

describe('POST /api/devices/me/master-session declares the slots', () => {
  it('refuses a session that declares no maxJobPanes, MASTER_SLOTS_UNDECLARED, and writes nothing', async () => {
    const res = await register({});
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('MASTER_SLOTS_UNDECLARED');
    expect(res.body.error?.refusals[0]?.detail).toContain('maxJobPanes');
    expect(
      await count(sql`SELECT count(*)::int AS n FROM agent_sessions WHERE kind = 'master'`),
    ).toBe(0);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM devices WHERE max_job_panes IS NOT NULL`),
    ).toBe(0);
  });

  it('stores the declared count on the device and answers it back', async () => {
    const res = await register({ maxJobPanes: 3 });
    expect(res.status).toBe(200);
    expect(res.body.maxJobPanes).toBe(3);
    expect(res.body.created).toBe(true);
    expect(await count(sql`SELECT max_job_panes AS n FROM devices WHERE id = ${deviceId}`)).toBe(3);
    const again = await register({ maxJobPanes: 2 });
    expect(again.body.sessionId, 'the same live master, re-found').toBe(res.body.sessionId);
    expect(await count(sql`SELECT max_job_panes AS n FROM devices WHERE id = ${deviceId}`)).toBe(2);
  });

  it('refuses zero, the cap plus one and a stray field with the valid shape named', async () => {
    for (const body of [{ maxJobPanes: 0 }, { maxJobPanes: 65 }, { maxJobPanes: 2, slots: 2 }]) {
      const res = await register(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(String((res.body as { message?: string }).message)).toContain(
        'maxJobPanes: integer 1-64',
      );
    }
  });

  it('lets a runner older than 0.18.0 register without the field (ISS-107 amnesty), its slots read undeclared', async () => {
    const old = await aBox('old-box', '0.17.0');
    const res = await register({}, old.auth);
    expect(res.status).toBe(200);
    expect(res.body.maxJobPanes).toBeNull();
    const s = await standing();
    const slots = s.slots as { max: number | null; undeclared: { code: string } | null };
    expect(slots.max, 'no guessed number').toBeNull();
    expect(slots.undeclared?.code).toBe('MASTER_SLOTS_UNDECLARED');
  });
});

describe('POST /api/devices/me/master-session/pass opens and closes a pass', () => {
  it('opens a pass, refuses a second open MASTER_PASS_ALREADY_OPEN, and holds one open row', async () => {
    const sessionId = await liveMaster();
    const opened = await pass({ op: 'open', sessionId, verb: 'dispatch', issueKey: 'ISS-1414' });
    expect(opened.status).toBe(201);
    const second = await pass({ op: 'open', sessionId, verb: 'fold' });
    expect(second.status).toBe(422);
    expect(second.body.error?.code).toBe('MASTER_PASS_ALREADY_OPEN');
    expect(second.body.error?.refusals[0]?.detail).toContain('ISS-1414');
    expect(
      await count(sql`SELECT count(*)::int AS n FROM master_passes WHERE ended_at IS NULL`),
    ).toBe(1);
  });

  it('lets exactly one of two concurrent opens through', async () => {
    const sessionId = await liveMaster();
    const both = await Promise.all([
      pass({ op: 'open', sessionId, verb: 'dispatch' }),
      pass({ op: 'open', sessionId, verb: 'triage' }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(await count(sql`SELECT count(*)::int AS n FROM master_passes`)).toBe(1);
  });

  it('closes the open pass with what it did, and refuses a close with none open MASTER_PASS_NOT_OPEN', async () => {
    const sessionId = await liveMaster();
    const never = await pass({ op: 'close', sessionId, dispatched: [], skipped: [], parked: [] });
    expect(never.status).toBe(422);
    expect(never.body.error?.code).toBe('MASTER_PASS_NOT_OPEN');
    expect(never.body.error?.refusals[0]?.detail).toContain('never opened');

    await pass({ op: 'open', sessionId, verb: 'dispatch' });
    const closed = await pass({
      op: 'close',
      sessionId,
      dispatched: ['ISS-1413'],
      skipped: [{ issueKey: 'ISS-1405', refusal: 'ISS-1402 blocks it (blocks edge)' }],
      parked: ['ISS-1409'],
    });
    expect(closed.status).toBe(200);
    const again = await pass({ op: 'close', sessionId, dispatched: [], skipped: [], parked: [] });
    expect(again.status).toBe(422);
    expect(again.body.error?.code).toBe('MASTER_PASS_NOT_OPEN');
    expect(again.body.error?.refusals[0]?.detail).toContain('dispatch pass');
  });

  it('answers 404 for a master another box registered, and MASTER_SESSION_ENDED for one that ended', async () => {
    const sessionId = await liveMaster();
    const other = await aBox('other-box', '0.18.0');
    const foreign = await pass({ op: 'open', sessionId, verb: 'triage' }, other.auth);
    expect(foreign.status).toBe(404);

    await post('/api/devices/me/master-session/close', { sessionId, reason: 'test ended it' });
    const ended = await pass({ op: 'open', sessionId, verb: 'triage' });
    expect(ended.status).toBe(422);
    expect(ended.body.error?.code).toBe('MASTER_SESSION_ENDED');
  });

  it('keeps a closed pass final: the trigger refuses an update and a delete by hand', async () => {
    const sessionId = await liveMaster();
    await pass({ op: 'open', sessionId, verb: 'judge' });
    await pass({ op: 'close', sessionId, dispatched: [], skipped: [], parked: [] });
    await expect(
      harness.db.execute(sql`UPDATE master_passes SET dispatched = ARRAY['ISS-9']::text[]`),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/MASTER_PASS_IMMUTABLE/) } });
    await expect(harness.db.execute(sql`DELETE FROM master_passes`)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/MASTER_PASS_IMMUTABLE/) },
    });
  });
});

describe('GET /api/projects/:id/masters/standing', () => {
  it('serves none with no slots while no master serves the project', async () => {
    const s = await standing();
    expect(s.state).toBe('none');
    expect(s.sessionId).toBeNull();
    expect(s.slots).toBeNull();
    expect(s.lastPass).toBeNull();
  });

  it('reads each field back from the passes the box opened and closed', async () => {
    const sessionId = await liveMaster(3);
    let s = await standing();
    expect(s.state).toBe('idle');
    expect(s.sessionId).toBe(sessionId);
    expect(s.device).toEqual({ id: deviceId, name: 'pass-box' });
    expect(s.slots).toEqual({ inUse: 0, max: 3, undeclared: null });
    expect(typeof s.lastBeatAt).toBe('string');

    await pass({ op: 'open', sessionId, verb: 'dispatch', issueKey: 'ISS-1414' });
    s = await standing();
    expect(s.state).toBe('in_pass');
    const open = s.pass as Record<string, unknown>;
    expect(open.verb).toBe('dispatch');
    expect(open.issueKey).toBe('ISS-1414');
    expect(typeof open.startedAt).toBe('string');
    expect(typeof open.id).toBe('string');

    await pass({
      op: 'close',
      sessionId,
      dispatched: ['ISS-1413'],
      skipped: [{ issueKey: 'ISS-1405', refusal: 'WORKFLOW_DESIGN_NOT_APPROVED' }],
      parked: ['ISS-1409'],
    });
    s = await standing();
    expect(s.state).toBe('idle');
    expect(s.pass).toBeNull();
    const last = s.lastPass as Record<string, unknown>;
    expect(last.id).toBe(open.id);
    expect(last.dispatched).toEqual(['ISS-1413']);
    expect(last.skipped).toEqual([
      { issueKey: 'ISS-1405', refusal: 'WORKFLOW_DESIGN_NOT_APPROVED' },
    ]);
    expect(last.parked).toEqual(['ISS-1409']);
    expect(Date.parse(String(last.endedAt))).toBeGreaterThanOrEqual(
      Date.parse(String(last.startedAt)),
    );
  });

  it('counts slots in use from occupying jobs and live run sessions on the box, a parked run holding none', async () => {
    await liveMaster(4);
    const run = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${run}, ${projectId}, 'system', 'running')`);
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, created_by, device_id, payload)
      VALUES (${randomUUID()}, ${projectId}, ${run}, 'code', 'running', ${ownerId}, ${deviceId}, '{}'::jsonb)`);
    for (const seq of [1, 2]) {
      await harness.db.execute(sql`
        INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
        VALUES (${randomUUID()}, ${projectId}, ${seq}, ${`issue ${seq}`}, 'draft', ${ownerId})`);
    }
    await openRunSession({ deviceId, projectId, issueKeys: ['ISS-1'], name: 'run-a' });
    const parked = await openRunSession({
      deviceId,
      projectId,
      issueKeys: ['ISS-2'],
      name: 'run-b',
    });
    await harness.db.execute(
      sql`UPDATE agent_sessions SET runtime_state = 'awaiting_input' WHERE id = ${parked.sessionId}`,
    );
    const slots = (await standing()).slots as { inUse: number; max: number };
    expect(slots).toEqual({ inUse: 2, max: 4, undeclared: null });
  });

  it('says silent exactly when the reaper fails the master, then none', async () => {
    const sessionId = await liveMaster();
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now() - interval '9 minutes',
             started_at = now() - interval '1 hour' WHERE id = ${sessionId}`);
    expect((await standing()).state).toBe('idle');
    expect(await reapSilentMasters()).toBe(0);
    await harness.db.execute(sql`
      UPDATE agent_sessions SET last_heartbeat_at = now() - interval '11 minutes' WHERE id = ${sessionId}`);
    expect((await standing()).state).toBe('silent');
    expect(await reapSilentMasters()).toBe(1);
    expect((await standing()).state).toBe('none');
  });

  it('refuses a person who is not a member, and the overview reads its slots from the same model', async () => {
    const stranger = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
    const res = await app.request(`/api/projects/${projectId}/masters/standing`, {
      headers: { Authorization: `Bearer ${await signUserToken(stranger)}` },
    });
    expect(res.status).toBe(403);

    await liveMaster(2);
    const overview = await app.request(`/api/projects/${projectId}/development/overview`, {
      headers: viewer,
    });
    expect(overview.status).toBe(200);
    const master = ((await overview.json()) as { signals: { master: Record<string, unknown> } })
      .signals.master;
    expect(master).toEqual({
      masters: 1,
      state: 'idle',
      slots: { inUse: 0, max: 2, undeclared: null },
      slotsNote: null,
    });
  });
});
