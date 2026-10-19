/**
 * ISS-1228 round 15 repair — every session read a screen judges silence on says whether core holds
 * the session's box online, so a session heard moments before its box dropped reads quiet rather than
 * Working on the sessions list, the session page and the Pipeline page. Read through the routes the
 * web reads, against a live database.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let deviceId: string;
let jwt: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
  projectId = (await createTestProject(harness.db, owner.id)).id;
  deviceId = (await createTestDevice(harness.db, owner.id)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  jwt = await signUserToken(owner.id);
});

async function get(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.baseUrl}/api${path}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

/** A run session heard ten seconds ago, on the test box or on none. */
async function liveSession(onBox: boolean): Promise<string> {
  const runId = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at)
    VALUES (${runId}, ${projectId}::uuid, 'system', 'running', now() - interval '10 minutes')
  `);
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO agent_sessions (id, project_id, device_id, pipeline_run_id, kind, status, title,
                                runtime_state, started_at, last_heartbeat_at)
    VALUES (${id}, ${projectId}::uuid, ${onBox ? deviceId : null}, ${runId}, 'run_session', 'running',
            'run: r', 'working', now() - interval '10 minutes', now() - interval '10 seconds')
  `);
  return id;
}

async function boxIs(status: 'online' | 'offline'): Promise<void> {
  await harness.db.execute(sql`UPDATE devices SET status = ${status} WHERE id = ${deviceId}::uuid`);
}

type Row = { id: string; boxOnline?: unknown };

async function readEverywhere(
  id: string,
): Promise<{ list: unknown; detail: unknown; pipeline: unknown }> {
  const list = (await get(`/agent-sessions?projectId=${projectId}`)).items as Row[];
  const detail = (await get(`/agent-sessions/${id}`)) as Row;
  const pipeline = (await get(`/projects/${projectId}/sessions-and-holds`)).sessions as Row[];
  return {
    list: list.find((r) => r.id === id)?.boxOnline,
    detail: detail.boxOnline,
    pipeline: pipeline.find((r) => r.id === id)?.boxOnline,
  };
}

describe('every session read says whether its box is online', () => {
  it('says false on the list, the session and the Pipeline read once its box has gone offline', async () => {
    const id = await liveSession(true);
    await boxIs('offline');
    expect(await readEverywhere(id)).toEqual({ list: false, detail: false, pipeline: false });
  });

  it('says true for a box core holds online', async () => {
    const id = await liveSession(true);
    await boxIs('online');
    expect(await readEverywhere(id)).toEqual({ list: true, detail: true, pipeline: true });
  });

  it('says null for a session that names no box', async () => {
    const id = await liveSession(false);
    expect(await readEverywhere(id)).toEqual({ list: null, detail: null, pipeline: null });
  });
});

describe('a box the stale sweep marks offline', () => {
  it('is told to the room of every project it serves, so their screens refresh its sessions', async () => {
    await bindTestRunner(harness.db, { projectId, deviceId });
    await harness.db.execute(sql`
      UPDATE devices SET status = 'online', last_seen_at = now() - interval '1 hour' WHERE id = ${deviceId}::uuid
    `);
    const { roomManager } = await import('../../src/ws/server.js');
    const { projectRoom } = await import('../../src/ws/rooms.js');
    const { runDeviceStaleSweep } = await import('../../src/devices/stale-detector.js');
    const publish = vi.spyOn(roomManager, 'publish');
    try {
      await runDeviceStaleSweep();
      expect(publish).toHaveBeenCalledWith(projectRoom(projectId), {
        event: 'device.status',
        data: { deviceId, projectId, status: 'offline' },
      });
    } finally {
      publish.mockRestore();
    }
  });
});
