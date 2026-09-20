/**
 * ISS-1119 — the two version numbers, over the real HTTP surface.
 *
 * Both are read by a browser, and a browser reaches neither through a router a
 * unit test mounts by hand. `/version` was mounted at the root only, where
 * `app.use('/api/*', corsMiddleware)` never runs, so the page could issue the
 * request and not read the answer; and the runner row's version is a join the
 * projection either selects or does not. Mount the routers yourself and both
 * assertions pass against the defect.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

const WEB_ORIGIN = 'http://localhost:3000';

let harness: TestDatabase;
let server: TestServer;
let mods: { signUserToken: typeof import('../../src/auth/jwt.js').signUserToken };

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  process.env.CORS_ORIGINS ??= WEB_ORIGIN;

  mods = { signUserToken: (await import('../../src/auth/jwt.js')).signUserToken };
  server = await startTestServer();
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
});

describe('the deployment reports its own version where a browser can read it', () => {
  it('answers the same body at the root mount and under /api', async () => {
    const root = await fetch(`${server.baseUrl}/version`);
    const api = await fetch(`${server.baseUrl}/api/version`);

    expect(root.status).toBe(200);
    expect(api.status).toBe(200);

    const rootBody = (await root.json()) as { version: string };
    const apiBody = (await api.json()) as { version: string; uptimeSeconds: number };

    expect(apiBody.version).toBe(rootBody.version);
    expect(apiBody.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof apiBody.uptimeSeconds).toBe('number');
  });

  it('lets the configured web origin read the answer, which the root mount does not', async () => {
    const api = await fetch(`${server.baseUrl}/api/version`, {
      headers: { Origin: WEB_ORIGIN },
    });
    const root = await fetch(`${server.baseUrl}/version`, {
      headers: { Origin: WEB_ORIGIN },
    });

    // The status belongs in this case and not only in the one above. The CORS
    // middleware runs on everything under `/api`, the 404 handler included, so
    // the header alone is present whether or not the route is mounted — an
    // assertion on it by itself passes against the unmounted tree.
    expect(api.status).toBe(200);
    expect(api.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
    expect(((await api.json()) as { version: string }).version).toMatch(/^\d+\.\d+\.\d+/);

    expect(root.status).toBe(200);
    expect(root.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('a project runner row carries the version its own device reported', () => {
  async function seed(agentVersion: string | null) {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'admin',
    });
    const device = await createTestDevice(harness.db, user.id, { agentVersion });
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status)
      VALUES (${randomUUID()}, ${project.id}, 'claude-code', ${device.id}, 'box', 'online')
    `);
    return { projectId: project.id, token: await mods.signUserToken(user.id) };
  }

  async function listRunners(projectId: string, token: string) {
    const res = await fetch(`${server.baseUrl}/api/projects/${projectId}/runners`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return {
      status: res.status,
      rows: (await res.json()) as Array<{ agentVersion: string | null }>,
    };
  }

  it('reports the version a device has reported', async () => {
    const { projectId, token } = await seed('0.17.0');

    const { status, rows } = await listRunners(projectId, token);

    expect(status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentVersion).toBe('0.17.0');
  });

  it('reports null — not an invented number — for a device that has reported none', async () => {
    const { projectId, token } = await seed(null);

    const { rows } = await listRunners(projectId, token);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty('agentVersion');
    expect(rows[0]?.agentVersion).toBeNull();
  });
});
