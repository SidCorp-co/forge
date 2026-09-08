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
  await bind(device.id, project.id);
  return {
    userId: user.id,
    token: await signUserToken(user.id),
    projectId: project.id,
    deviceId: device.id,
  };
}

/** The runners row that makes this box a box of this project. */
async function bind(deviceId: string, projectId: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at)
    VALUES (${randomUUID()}, ${projectId}, 'claude-code', ${deviceId}, 'box', 'online', now())
  `);
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

describe('a member reading the fleet', () => {
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
});

describe('what one box reported', () => {
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
    await bind(other.id, m.projectId);
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
    await bind(a.deviceId, b.projectId);
    await applySnapshot({
      deviceId: a.deviceId,
      entries: [entry(a.projectId), entry(b.projectId, { runId: 'run-b' })],
    });

    const body = (await (await read(a.projectId, a.token)).json()) as {
      items: Array<{ runId: string }>;
    };
    expect(body.items.map((r) => r.runId)).toEqual(['run-1']);
  });

  // cm:guard every paired box in the fleet holds a valid device token, so the project on a snapshot entry is a CLAIM. Without this check any box could put a worktree path and a pid into any project's read surface (ISS-934).
  it('drops a run naming a project this box is not bound to', async () => {
    const a = await member();
    const b = await member();
    await applySnapshot({
      deviceId: a.deviceId,
      entries: [entry(a.projectId), entry(b.projectId, { runId: 'run-b' })],
    });

    const mine = (await (await read(a.projectId, a.token)).json()) as {
      items: Array<{ runId: string }>;
    };
    expect(mine.items.map((r) => r.runId)).toEqual(['run-1']);
    const theirs = (await (await read(b.projectId, b.token)).json()) as { count: number };
    expect(theirs.count).toBe(0);
  });
});

// cm:why criterion 52 wants the three close-loop marks rendered as THREE, and the UI can only render what this surface carries: `issues[].leaseReturned` was the only one of them here, so a screen built on today's shape could show one flag and would have to guess the other two. `snapshot` publishes unclosed runs only, which is exactly the window where the three disagree.
describe('the three close-loop marks', () => {
  it('carries each mark separately, so a half-closed run reads as half-closed', async () => {
    const m = await member();
    const sessionId = await seedSession(m.projectId, '2026-09-09T09:00:00Z');
    await applySnapshot({
      deviceId: m.deviceId,
      entries: [
        entry(m.projectId, {
          sessionId,
          sessionTerminalAtEpochS: Math.floor(Date.parse('2026-09-09T10:00:00.000Z') / 1000),
          worktreeGoneAtEpochS: null,
          issues: [
            { issueKey: 'ISS-934', leaseReturned: true },
            { issueKey: 'ISS-933', leaseReturned: false },
          ],
        }),
      ],
    });

    const body = (await (await read(m.projectId, m.token)).json()) as {
      items: Array<Record<string, unknown>>;
    };
    const row = body.items[0];
    if (!row) throw new Error('the snapshot wrote one row and the read must return it');

    expect(
      row.sessionTerminalAt,
      'the session reaching terminal is one mark of three and the reader must see it on its own — collapsed into a single `closed` flag, a run whose session ended but whose worktree is still on disk is indistinguishable from one that finished cleanly (ISS-964 criterion 52)',
    ).toBe('2026-09-09T10:00:00.000Z');
    expect(
      row.worktreeGoneAt,
      'and the mark NOT yet set must come back null rather than absent: absent is what a field the box never sent looks like, and the two mean different things to a reader deciding whether a diff is still recoverable',
    ).toBeNull();
    expect(
      (row.issues as Array<{ issueKey: string; leaseReturned: boolean }>).map(
        (i) => i.leaseReturned,
      ),
      'the third mark is per-issue and stays per-issue: a run over three issues can have returned one lease and not the others',
    ).toEqual([true, false]);
  });
});
