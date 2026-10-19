/**
 * ISS-1228 round 10 — a run's wait is aged from when it began. Every snapshot restamps
 * `observed_at`, so a session waiting on a person for half an hour read "0s" on the dashboard's
 * Needs you. `work_since` keeps the time core first saw the run's current work, blocker and wait:
 * a snapshot repeating them keeps it, one changing any of them starts it again. Read through the
 * writer the box's snapshot route calls, the run rows the Agents runs tab reads and the session
 * read the dashboard reads, against a live database.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
type Entry = Parameters<Apply>[0]['entries'][number];

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
  const { agentSessionRoutes } = await import('../../src/agent-sessions/routes.js');
  applySnapshot = (await import('../../src/devices/run-ledger.js')).applyRunLedgerSnapshot;
  const { errorHandler } = await import('../../src/middleware/error.js');
  signUserToken = (await import('../../src/auth/jwt.js')).signUserToken;

  app = new Hono();
  app.route('/api/projects', runLedgerRoutes);
  app.route('/api/agent-sessions', agentSessionRoutes);
  app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  vi.useRealTimers();
  await truncateAll(harness.db);
});

interface World {
  token: string;
  projectId: string;
  deviceId: string;
  sessionId: string;
}

async function world(): Promise<World> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const project = await createTestProject(harness.db, user.id);
  await createTestProjectMember(harness.db, {
    userId: user.id,
    projectId: project.id,
    role: 'member',
  });
  const device = await createTestDevice(harness.db, user.id);
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at)
    VALUES (${randomUUID()}, ${project.id}, 'claude-code', ${device.id}, 'box', 'online', now())
  `);
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${project.id}, 'system', 'running')
  `);
  const sessionId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status, runtime_state,
                                title, started_at, last_heartbeat_at)
    VALUES (${sessionId}, ${project.id}, ${runId}, ${device.id}, 'run_session', 'running',
            'awaiting_input', 'run: grp-1', now(), now())
  `);
  return {
    token: await signUserToken(user.id),
    projectId: project.id,
    deviceId: device.id,
    sessionId,
  };
}

const entry = (w: World, over: Partial<Entry> = {}): Entry =>
  ({
    runId: 'run-1',
    projectId: w.projectId,
    sessionId: w.sessionId,
    masterSessionId: null,
    pid: 4242,
    worktreePath: '/repo/.worktrees/grp-1',
    bootId: 'boot-a',
    incarnation: 'live',
    work: 'blocked',
    blockerKind: 'human',
    waitingOn: 'approve the restore',
    sessionTerminalAtEpochS: null,
    worktreeGoneAtEpochS: null,
    issues: [],
    ...over,
  }) as Entry;

/** One snapshot, applied with core's clock at `at`. */
async function snapshot(w: World, at: string, over: Partial<Entry> = {}): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
  try {
    await applySnapshot({ deviceId: w.deviceId, entries: [entry(w, over)] });
  } finally {
    vi.useRealTimers();
  }
}

async function runRow(w: World): Promise<Record<string, unknown>> {
  const res = await app.request(`/api/projects/${w.projectId}/run-sessions`, {
    headers: { Authorization: `Bearer ${w.token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<Record<string, unknown>> };
  return body.items[0] as Record<string, unknown>;
}

async function sessionReport(w: World): Promise<Record<string, unknown> | null> {
  const res = await app.request(`/api/agent-sessions?projectId=${w.projectId}`, {
    headers: { Authorization: `Bearer ${w.token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    items: Array<{ id: string; report: Record<string, unknown> | null }>;
  };
  return body.items.find((i) => i.id === w.sessionId)?.report ?? null;
}

describe('since when a run has waited (ISS-1228 round 10)', () => {
  it('keeps the time the wait began while every later snapshot repeats it', async () => {
    const w = await world();
    await snapshot(w, '2026-10-16T09:00:00.000Z');
    await snapshot(w, '2026-10-16T09:15:00.000Z');
    await snapshot(w, '2026-10-16T09:30:00.000Z');

    const row = await runRow(w);
    expect(row.workSince).toBe('2026-10-16T09:00:00.000Z');
    expect(row.observedAt).toBe('2026-10-16T09:30:00.000Z');
    const report = await sessionReport(w);
    expect(report?.since).toBe('2026-10-16T09:00:00.000Z');
    expect(report?.observedAt).toBe('2026-10-16T09:30:00.000Z');
  });

  it('starts again when the work, the blocker or the wait changes', async () => {
    const w = await world();
    await snapshot(w, '2026-10-16T09:00:00.000Z');
    await snapshot(w, '2026-10-16T09:10:00.000Z', { waitingOn: 'approve the second restore' });
    expect((await runRow(w)).workSince).toBe('2026-10-16T09:10:00.000Z');

    await snapshot(w, '2026-10-16T09:20:00.000Z', {
      waitingOn: 'approve the second restore',
      blockerKind: 'machine',
    });
    expect((await runRow(w)).workSince).toBe('2026-10-16T09:20:00.000Z');

    await snapshot(w, '2026-10-16T09:30:00.000Z', {
      work: 'runnable',
      blockerKind: null,
      waitingOn: null,
    });
    expect((await runRow(w)).workSince).toBe('2026-10-16T09:30:00.000Z');
    await snapshot(w, '2026-10-16T09:40:00.000Z', {
      work: 'runnable',
      blockerKind: null,
      waitingOn: null,
    });
    expect((await runRow(w)).workSince).toBe('2026-10-16T09:30:00.000Z');
  });

  it("carries the session's runtime state on the run row, as core holds it", async () => {
    const w = await world();
    await snapshot(w, '2026-10-16T09:00:00.000Z', {
      work: 'runnable',
      blockerKind: null,
      waitingOn: null,
    });
    expect((await runRow(w)).sessionRuntimeState).toBe('awaiting_input');
  });

  it('lets a writer that does not name the column still insert, stamping the insert', async () => {
    const w = await world();
    await harness.db.execute(sql`
      INSERT INTO device_run_ledger (device_id, run_id, project_id, session_id, worktree_path, boot_id,
                                     incarnation, work, issues, observed_at)
      VALUES (${w.deviceId}::uuid, 'run-old', ${w.projectId}::uuid, ${w.sessionId}::uuid, '/wt', 'b',
              'live', 'blocked', '[]'::jsonb, now())
    `);
    const [row] = (await harness.db.execute(sql`
      SELECT work_since IS NOT NULL AS stamped FROM device_run_ledger WHERE run_id = 'run-old'
    `)) as unknown as Array<{ stamped: boolean }>;
    expect(row?.stamped).toBe(true);
  });
});
