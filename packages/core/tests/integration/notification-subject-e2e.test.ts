/**
 * ISS-1168 — a notification about no issue names what it is about: the runner, session, step,
 * schedule or project its title would otherwise leave the reader to guess, and opens its project.
 */

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

vi.mock('../../src/schedules/script/executor.js', () => ({
  SCRIPT_TIMEOUT_MS: 30_000,
  runScheduleScript: async () => ({
    status: 'success',
    output: '',
    notifications: [{ title: 'All 12 endpoints answered' }],
  }),
}));

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  recordAndDeliver: typeof import('../../src/notifications/deliver.js').recordAndDeliver;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  emitPipelineWedge: typeof import('../../src/pipeline/wedge.js').emitPipelineWedge;
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  handlePmJobFailedAutoDisable: typeof import('../../src/pm/auto-disable.js').handlePmJobFailedAutoDisable;
};

type Row = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  unread: boolean;
  readAt: string | null;
  members: number;
  openMembers: number;
  issueId: string | null;
  projectId: string | null;
  projectSlug: string | null;
  projectName: string | null;
  explanation: string | null;
  groupKey: string | null;
  resolvedNotice: boolean;
};
type Page = { items: Row[]; total: number; hasMore: boolean };

let harness: TestDatabase;
let mods: Mods;
let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
let owner: string;
let project: { id: string; slug: string; name: string };
let token: string;

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

  const deliver = await import('../../src/notifications/deliver.js');
  const wedge = await import('../../src/pipeline/wedge.js');
  const autoDisable = await import('../../src/pm/auto-disable.js');
  mods = {
    emitPipelineWedge: wedge.emitPipelineWedge,
    handlePmJobFailedAutoDisable: autoDisable.handlePmJobFailedAutoDisable,
    recordAndDeliver: deliver.recordAndDeliver,
  };

  const { notificationRoutes } = await import('../../src/notifications/routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/notifications', notificationRoutes);
  app.onError(errorHandler);
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  owner = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  project = await createTestProject(harness.db, owner, { name: 'Invoicing' });
  const { signUserToken } = await import('../../src/auth/jwt.js');
  token = await signUserToken(owner);
});

const auth = () => ({ authorization: `Bearer ${token}` });

async function inbox(query = ''): Promise<Page> {
  const res = await app.request(`/api/notifications${query}`, { headers: auth() });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = (await res.json()) as { items: Row[]; total: number; hasMore: boolean };
  return { items: body.items, total: body.total, hasMore: body.hasMore };
}

describe('a notification about no issue', () => {
  const pipelineRun = async () => {
    const id = crypto.randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${id}, ${project.id}, 'interactive', 'running')`);
    return id;
  };
  const only = async () => ((await inbox()).items as Row[]).filter((r) => !r.resolvedNotice);

  it('names the runner it is about by the name the Runners page shows, and opens its project', async () => {
    const device = await createTestDevice(harness.db, owner, { name: 'build-box-7' });
    const runner = crypto.randomUUID();
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, device_id, type, name, status)
      VALUES (${runner}, ${project.id}, ${device.id}, 'claude-code', 'runner-internal-name', 'online')`);
    await mods.emitPipelineWedge({
      projectId: project.id,
      hop: 'dispatch',
      entity: 'runner',
      entityId: runner,
      reason: 'auth_dead:expired',
      action: 'sign in again',
      title: 'A runner can no longer authenticate, and will take no more work',
    });
    const [row] = await only();
    expect(row?.title).toBe(
      'build-box-7 — A runner can no longer authenticate, and will take no more work',
    );
    expect(row?.projectSlug).toBe(project.slug);
    expect(row?.issueId).toBeNull();
  });

  it('names the session it is about by its title and the device it ran on', async () => {
    const device = await createTestDevice(harness.db, owner, { name: 'build-box-8' });
    const session = crypto.randomUUID();
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, device_id, kind, status, title)
      VALUES (${session}, ${project.id}, ${await pipelineRun()}, ${device.id}, 'chat', 'failed', 'Nightly sync')`);
    await mods.emitPipelineWedge({
      projectId: project.id,
      hop: 'heartbeat',
      entity: 'session',
      entityId: session,
      reason: 'stale',
      action: 'check the device',
    });
    const [row] = await only();
    expect(row?.title).toBe('Nightly sync on build-box-8 — A session stopped checking in');
  });

  it('names the step it is about by its kind', async () => {
    const job = crypto.randomUUID();
    await harness.db.execute(sql`
      INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, created_by)
      VALUES (${job}, ${project.id}, ${await pipelineRun()}, 'custom', 'queued', ${owner})`);
    await mods.emitPipelineWedge({
      projectId: project.id,
      hop: 'dispatch',
      entity: 'job',
      entityId: job,
      reason: 'held',
      action: 'wait',
      title: 'A release was cancelled because no machine picked it up',
    });
    const [row] = await only();
    expect(row?.title).toBe(
      'custom step — A release was cancelled because no machine picked it up',
    );
  });

  it('names its project where the project is the subject', async () => {
    await mods.emitPipelineWedge({
      projectId: project.id,
      hop: 'dispatch',
      entity: 'capacity',
      entityId: `capacity:${project.id}:build`,
      reason: 'no runner',
      action: 'bring one online',
      title: 'No capacity: no runner online for this project',
    });
    const [row] = await only();
    expect(row?.title).toBe('Invoicing — No capacity: no runner online for this project');
    expect(row?.projectSlug).toBe(project.slug);
  });

  it('names the schedule a script report came from, by the schedule the run was dispatched for', async () => {
    const { dispatchScheduleRun } = await import('../../src/schedules/dispatch.js');
    const schedule = crypto.randomUUID();
    await harness.db.execute(sql`
      INSERT INTO schedules (id, project_id, name, cron, kind, script)
      VALUES (${schedule}, ${project.id}, 'Nightly check', '0 3 * * *', 'script',
              ${"ctx.notify({ title: 'All 12 endpoints answered' });"})`);
    const result = await dispatchScheduleRun({
      schedule: {
        id: schedule,
        name: 'Nightly check',
        projectId: project.id,
        prompt: null,
        targetProjectSlug: null,
        kind: 'script',
        script: "ctx.notify({ title: 'All 12 endpoints answered' });",
      },
      actorUserId: owner,
    });
    expect(result.ok).toBe(true);
    const [row] = await only();
    expect(row?.title).toBe('Nightly check — All 12 endpoints answered');
  });

  it('names the project in a record written without the door, and leaves a title that already does', async () => {
    for (let i = 0; i < 3; i += 1) {
      await harness.db.execute(sql`
        INSERT INTO jobs (id, project_id, pipeline_run_id, type, status, created_by) VALUES (${crypto.randomUUID()}, ${project.id}, ${await pipelineRun()}, 'pm', 'failed', ${owner})`);
    }
    await mods.handlePmJobFailedAutoDisable({ type: 'pm', projectId: project.id } as never);
    await mods.recordAndDeliver({
      recipients: [owner],
      projectId: project.id,
      type: 'pm_escalation',
      title: 'Invoicing needs a decision on its release window',
    });
    const titles = (await only()).map((r) => r.title).sort();
    expect(titles).toEqual([
      'Invoicing needs a decision on its release window',
      'Invoicing — PM cadence auto-disabled',
    ]);
  });
});
