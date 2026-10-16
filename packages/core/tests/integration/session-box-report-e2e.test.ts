/**
 * ISS-1228 — a session read carries what its box last reported about it, so the session page and the
 * sessions list can say Blocked where the box says so. Read through the routes the web reads, against
 * a live database, beside the entries that must not answer for the session.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
// biome-ignore lint/suspicious/noExplicitAny: test-only mount
let app: any;
let signUserToken: typeof import('../../src/auth/jwt.js')['signUserToken'];

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
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

  const [listMod, errMod, jwtMod] = await Promise.all([
    import('../../src/agent-sessions/routes.js'),
    import('../../src/middleware/error.js'),
    import('../../src/auth/jwt.js'),
  ]);
  signUserToken = jwtMod.signUserToken;
  app = new Hono();
  app.route('/api/agent-sessions', listMod.agentSessionRoutes);
  app.onError(errMod.errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

interface World {
  userId: string;
  projectId: string;
  otherProjectId: string;
  deviceId: string;
  token: string;
}

async function seedWorld(): Promise<World> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  const other = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'member',
  });
  const device = await createTestDevice(harness.db, user.id);
  return {
    userId: user.id,
    projectId: project.id,
    otherProjectId: other.id,
    deviceId: device.id,
    token: await signUserToken(user.id),
  };
}

async function runningSession(w: World): Promise<string> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status)
    VALUES (${runId}, ${w.projectId}::uuid, 'system', 'running')
  `);
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title,
                                runtime_state, started_at, last_heartbeat_at)
    VALUES (${id}, ${w.projectId}::uuid, ${w.deviceId}::uuid, ${runId}, 'run_session', 'running',
            'a run', 'working', now(), now())
  `);
  return id;
}

async function ledger(
  w: World,
  sessionId: string,
  entry: { work: string; blockerKind?: string; waitingOn?: string; at: string; projectId?: string },
): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO device_run_ledger (device_id, run_id, project_id, session_id, worktree_path, boot_id,
                                   incarnation, work, blocker_kind, waiting_on, issues, observed_at)
    VALUES (${w.deviceId}::uuid, ${randomUUID()}, ${entry.projectId ?? w.projectId}::uuid,
            ${sessionId}::uuid, '/tmp/wt', 'boot-1', 'live', ${entry.work},
            ${entry.blockerKind ?? null}, ${entry.waitingOn ?? null}, '[]'::jsonb, ${entry.at}::timestamptz)
  `);
}

const get = (path: string, token: string) =>
  app.request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } });

interface Report {
  incarnation: string;
  work: string;
  blockerKind: string | null;
  waitingOn: string | null;
  observedAt: string;
}

describe('a session read carries its box report (ISS-1228)', () => {
  it("lists each session with its box's newest report in the box's own words, and null where none", async () => {
    const w = await seedWorld();
    const blocked = await runningSession(w);
    const silent = await runningSession(w);
    await ledger(w, blocked, { work: 'runnable', at: '2026-10-16T07:00:00.000Z' });
    await ledger(w, blocked, {
      work: 'blocked',
      blockerKind: 'human',
      waitingOn: 'approve the database restore in Coolify',
      at: '2026-10-16T08:00:00.000Z',
    });

    const res = await get(`/api/agent-sessions?projectId=${w.projectId}`, w.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; report: Report | null }> };
    const byId = new Map(body.items.map((i) => [i.id, i.report]));
    expect(byId.get(blocked)).toEqual({
      incarnation: 'live',
      work: 'blocked',
      blockerKind: 'human',
      waitingOn: 'approve the database restore in Coolify',
      observedAt: '2026-10-16T08:00:00.000Z',
    });
    expect(byId.has(silent)).toBe(true);
    expect(byId.get(silent)).toBeNull();
  });

  it('reads the report on the one-session read too', async () => {
    const w = await seedWorld();
    const id = await runningSession(w);
    await ledger(w, id, {
      work: 'blocked',
      blockerKind: 'machine',
      waitingOn: 'the CI run',
      at: '2026-10-16T08:00:00.000Z',
    });

    const res = await get(`/api/agent-sessions/${id}`, w.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; report: Report | null };
    expect(body.report?.work).toBe('blocked');
    expect(body.report?.waitingOn).toBe('the CI run');
  });

  it("takes no report from an entry a box filed under another project than the session's", async () => {
    const w = await seedWorld();
    const id = await runningSession(w);
    await ledger(w, id, { work: 'runnable', at: '2026-10-16T07:00:00.000Z' });
    await ledger(w, id, {
      work: 'blocked',
      blockerKind: 'human',
      waitingOn: 'filed under the wrong project',
      at: '2026-10-16T09:00:00.000Z',
      projectId: w.otherProjectId,
    });

    const res = await get(`/api/agent-sessions/${id}`, w.token);
    const body = (await res.json()) as { report: Report | null };
    expect(body.report?.work).toBe('runnable');
  });
});
