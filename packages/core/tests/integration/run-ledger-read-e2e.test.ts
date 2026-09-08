/**
 * ISS-934 — a box's session registry, read by someone who is not on the box.
 *
 * The gap this closes is not "core has no rows". Core knew a run session
 * existed. What nothing outside the box could name was its parent master, its
 * pid and its worktree, and what nothing could tell apart was a run waiting
 * from a run dead. So the assertions here are about the fields, the replace
 * semantics of a snapshot, and where "last activity" is read from — the three
 * places a mirror of somebody else's state goes wrong.
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

type Apply = typeof import('../../src/devices/run-ledger.js').applyRunLedgerSnapshot;

describe('run ledger read surface', () => {
  let harness: TestDatabase;
  let app: Hono;
  let applySnapshot: Apply;
  let signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;

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

    const { runLedgerRoutes } = await import('../../src/devices/run-ledger-routes.js');
    applySnapshot = (await import('../../src/devices/run-ledger.js')).applyRunLedgerSnapshot;
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;

    app = new Hono();
    app.use('*', requestId());
    app.route('/api/projects', runLedgerRoutes);
    app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function member(): Promise<{
    userId: string;
    token: string;
    projectId: string;
    deviceId: string;
  }> {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'member',
    });
    const device = await createTestDevice(harness.db, user.id);
    return {
      userId: user.id,
      token: await signUserToken(user.id),
      projectId: project.id,
      deviceId: device.id,
    };
  }

  /** A run session as core mints one, so the join has something to read. */
  async function seedSession(projectId: string, heartbeat: string): Promise<string> {
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, issue_id, kind, status, started_at)
      VALUES (${runId}, ${projectId}, ${null}, 'system', 'running', now())
    `);
    const sessionId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions
        (id, project_id, pipeline_run_id, status, last_heartbeat_at, title, created_at, updated_at)
      VALUES (${sessionId}, ${projectId}, ${runId}, 'running', ${heartbeat}, 'run: grp-1', now(), now())
    `);
    return sessionId;
  }

  function entry(projectId: string, over: Record<string, unknown> = {}) {
    return {
      runId: 'run-1',
      projectId,
      sessionId: null,
      masterSessionId: null,
      pid: 4242,
      worktreePath: '/repo/.worktrees/grp-1',
      bootId: 'boot-a',
      incarnation: 'live',
      work: 'runnable',
      blockerKind: null,
      waitingOn: null,
      issues: [
        { issueKey: 'ISS-934', leaseReturned: false },
        { issueKey: 'ISS-933', leaseReturned: true },
      ],
      ...over,
    } as Parameters<Apply>[0]['entries'][number];
  }

  async function read(projectId: string, token: string): Promise<Response> {
    return app.request(`/api/projects/${projectId}/run-sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it('answers a member with the parent, the pid and the worktree the box reported', async () => {
    const m = await member();
    const masterSessionId = await seedSession(m.projectId, '2026-09-08T09:00:00Z');
    const sessionId = await seedSession(m.projectId, '2026-09-08T09:30:00Z');
    await applySnapshot({
      deviceId: m.deviceId,
      entries: [entry(m.projectId, { sessionId, masterSessionId })],
    });

    const res = await read(m.projectId, m.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; items: Array<Record<string, unknown>> };
    expect(body.count).toBe(1);
    const row = body.items[0] as Record<string, unknown>;
    expect(row.masterSessionId).toBe(masterSessionId);
    expect(row.pid).toBe(4242);
    expect(row.worktreePath).toBe('/repo/.worktrees/grp-1');
    expect(row.bootId).toBe('boot-a');
    expect(row.incarnation).toBe('live');
    expect(row.work).toBe('runnable');
    expect(row.deviceId).toBe(m.deviceId);
    expect(typeof row.observedAt).toBe('string');
    expect(row.issues).toEqual([
      { issueKey: 'ISS-934', leaseReturned: false },
      { issueKey: 'ISS-933', leaseReturned: true },
    ]);
  });

  it('reads last activity from the agent session, not from the box', async () => {
    const m = await member();
    const sessionId = await seedSession(m.projectId, '2026-09-08T09:30:00Z');
    await applySnapshot({ deviceId: m.deviceId, entries: [entry(m.projectId, { sessionId })] });

    const body = (await (await read(m.projectId, m.token)).json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items[0]?.sessionStatus).toBe('running');
    expect(String(body.items[0]?.lastActivityAt)).toContain('2026-09-08T09:30:00');
  });

  it('retires a run the newest snapshot from that device no longer names', async () => {
    const m = await member();
    await applySnapshot({
      deviceId: m.deviceId,
      entries: [entry(m.projectId), entry(m.projectId, { runId: 'run-2' })],
    });
    await applySnapshot({
      deviceId: m.deviceId,
      entries: [entry(m.projectId, { runId: 'run-2' })],
    });

    const body = (await (await read(m.projectId, m.token)).json()) as {
      items: Array<{ runId: string }>;
    };
    expect(body.items.map((r) => r.runId)).toEqual(['run-2']);
  });

  it('leaves another box alone when one box reports nothing', async () => {
    const m = await member();
    const other = await createTestDevice(harness.db, m.userId);
    await applySnapshot({ deviceId: m.deviceId, entries: [entry(m.projectId)] });
    await applySnapshot({ deviceId: other.id, entries: [entry(m.projectId, { runId: 'run-9' })] });
    await applySnapshot({ deviceId: m.deviceId, entries: [] });

    const body = (await (await read(m.projectId, m.token)).json()) as {
      items: Array<{ runId: string; deviceId: string }>;
    };
    expect(body.items.map((r) => r.runId)).toEqual(['run-9']);
    expect(body.items[0]?.deviceId).toBe(other.id);
  });

  it('refuses a caller with no access to the project', async () => {
    const m = await member();
    const stranger = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
    );
    await applySnapshot({ deviceId: m.deviceId, entries: [entry(m.projectId)] });

    const res = await read(m.projectId, await signUserToken(stranger.id));
    expect(res.status).toBe(403);
  });

  it('shows one project nothing of another project on the same box', async () => {
    const a = await member();
    const b = await member();
    await applySnapshot({
      deviceId: a.deviceId,
      entries: [entry(a.projectId), entry(b.projectId, { runId: 'run-b' })],
    });

    const body = (await (await read(a.projectId, a.token)).json()) as {
      items: Array<{ runId: string }>;
    };
    expect(body.items.map((r) => r.runId)).toEqual(['run-1']);
  });
});
