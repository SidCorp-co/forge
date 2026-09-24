/**
 * ISS-1234 — a box's failed pool reads, carried off the box on the heartbeat and
 * kept on the runner row, against real Postgres.
 *
 * The reads that failed were answered by the gateway (520, 522, 525) and never
 * reached core, so this is the only way core learns of them. What the unit tests
 * cannot prove is the crossing: that the statement keyed on (device, project)
 * writes the right row, clears the ones the box's list omits, and that the two
 * surfaces an operator reads — the project's runners route and `forge_runners` —
 * still carry the condition once it has been through a heartbeat.
 *
 * The report is the fixture both languages read, `src/devices/pool-read-report.fixture.json`,
 * with its project ids pointed at this suite's projects.
 */

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  pairMockDevice,
  registerIntegrationsForTest,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../src/devices/pool-read-report.fixture.json', import.meta.url), 'utf8'),
) as { pool: { projects: Array<Record<string, unknown>> } };

const [BLIND, INTERMITTENT] = fixture.pool.projects as [
  Record<string, unknown>,
  Record<string, unknown>,
];

describe('a box reports its pool reads and core keeps them on the runner', () => {
  let harness: TestDatabase;
  let server!: TestServer;
  let signUserToken!: typeof import('../../src/auth/jwt.js').signUserToken;
  let forgeRunnersTool!: typeof import('../../src/mcp/tools/forge-runners.js').forgeRunnersTool;

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
    await registerIntegrationsForTest();
    ({ signUserToken } = await import('../../src/auth/jwt.js'));
    ({ forgeRunnersTool } = await import('../../src/mcp/tools/forge-runners.js'));
    server = await startTestServer();
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  /** One device bound to two projects, and a third project bound to another device. */
  async function twoProjectBox() {
    const user = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
    const first = await createTestProject(harness.db, user.id);
    const second = await createTestProject(harness.db, user.id);
    const jwt = await signUserToken(user.id);
    const device = await pairMockDevice({ server, projectId: first.id, userJwt: jwt });
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at)
      SELECT gen_random_uuid(), ${second.id}, 'claude-code', ${device.id}, 'second', 'online', now()
      WHERE NOT EXISTS (
        SELECT 1 FROM runners WHERE project_id = ${second.id} AND device_id = ${device.id}
      )
    `);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at)
      SELECT gen_random_uuid(), ${first.id}, 'claude-code', ${device.id}, 'first', 'online', now()
      WHERE NOT EXISTS (
        SELECT 1 FROM runners WHERE project_id = ${first.id} AND device_id = ${device.id}
      )
    `);
    const other = await pairMockDevice({ server, projectId: second.id, userJwt: jwt });
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at)
      SELECT gen_random_uuid(), ${second.id}, 'claude-code', ${other.id}, 'other', 'online', now()
      WHERE NOT EXISTS (
        SELECT 1 FROM runners WHERE project_id = ${second.id} AND device_id = ${other.id}
      )
    `);
    return { user, jwt, first, second, device, other };
  }

  const beat = (token: string, body: unknown) =>
    fetch(`${server.baseUrl}/api/devices/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const report = (...projects: Array<[Record<string, unknown>, string]>) => ({
    projects: projects.map(([c, projectId]) => ({ ...c, projectId })),
  });

  const poolReadOf = async (deviceId: string, projectId: string) => {
    const rows = (await harness.db.execute(sql`
      SELECT pool_read FROM runners WHERE device_id = ${deviceId} AND project_id = ${projectId}
    `)) as unknown as Array<{ pool_read: Record<string, unknown> | null }>;
    expect(rows).toHaveLength(1);
    return rows[0]?.pool_read ?? null;
  };

  // Criterion 14.
  it('keeps each condition on the runner of that device and project, with when it was heard', async () => {
    const { device, first, second } = await twoProjectBox();
    const res = await beat(device.token, {
      agentVersion: '0.17.18',
      pool: report([BLIND, first.id], [INTERMITTENT, second.id]),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, pool: { accepted: true } });

    const a = await poolReadOf(device.id, first.id);
    expect(a).toMatchObject({ verdict: 'blind', consecutive: 3, lastFailure: { status: 525 } });
    expect(typeof a?.receivedAt).toBe('string');
    expect(await poolReadOf(device.id, second.id)).toMatchObject({
      verdict: 'intermittent',
      lastFailure: { status: 520 },
    });
  });

  // Criterion 14, the key: another box bound to the same project is not this box.
  it('writes nothing onto another device bound to the same project', async () => {
    const { device, other, second } = await twoProjectBox();
    await beat(device.token, { pool: report([BLIND, second.id]) });
    expect(await poolReadOf(device.id, second.id)).toMatchObject({ verdict: 'blind' });
    expect(await poolReadOf(other.id, second.id)).toBeNull();
  });

  // Criterion 15.
  it('clears the condition of a project the next list omits, and only that one', async () => {
    const { device, first, second } = await twoProjectBox();
    await beat(device.token, { pool: report([BLIND, first.id], [INTERMITTENT, second.id]) });
    const res = await beat(device.token, { pool: report([BLIND, first.id]) });
    expect(res.status).toBe(200);
    expect(await poolReadOf(device.id, first.id)).toMatchObject({ verdict: 'blind' });
    expect(await poolReadOf(device.id, second.id)).toBeNull();

    await beat(device.token, { pool: { projects: [] } });
    expect(await poolReadOf(device.id, first.id)).toBeNull();
  });

  // Criterion 16.
  it('leaves every stored condition as it was when the heartbeat carries no pool key', async () => {
    const { device, first, second } = await twoProjectBox();
    await beat(device.token, { pool: report([BLIND, first.id], [INTERMITTENT, second.id]) });
    const res = await beat(device.token, { agentVersion: '0.17.18' });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('pool');
    expect(await poolReadOf(device.id, first.id)).toMatchObject({ verdict: 'blind' });
    expect(await poolReadOf(device.id, second.id)).toMatchObject({ verdict: 'intermittent' });
  });

  // Criterion 17.
  it('refuses a report it cannot read by name, stores nothing, and keeps the box online', async () => {
    const { device, first, second } = await twoProjectBox();
    await beat(device.token, { pool: report([BLIND, first.id]) });
    const res = await beat(device.token, {
      agentVersion: '0.17.18',
      pool: report([{ ...BLIND, verdict: 'catastrophe' }, first.id], [INTERMITTENT, second.id]),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      pool?: { accepted: boolean; reason?: string };
    };
    expect(body.ok).toBe(true);
    expect(body.pool?.accepted).toBe(false);
    expect(body.pool?.reason).toMatch(/^pool\.projects\.0\.verdict: /);
    expect(await poolReadOf(device.id, first.id)).toMatchObject({ verdict: 'blind' });
    expect(await poolReadOf(device.id, second.id)).toBeNull();
    const status = (await harness.db.execute(sql`
      SELECT status FROM devices WHERE id = ${device.id}
    `)) as unknown as Array<{ status: string }>;
    expect(status[0]?.status).toBe('online');
  });

  // Criteria 19 and 20.
  it('shows the condition on the project runners route and in forge_runners list', async () => {
    const { user, jwt, device, first } = await twoProjectBox();
    await beat(device.token, { pool: report([BLIND, first.id]) });

    const res = await fetch(`${server.baseUrl}/api/projects/${first.id}/runners`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ deviceId: string; poolRead: unknown }>;
    const mine = rows.find((r) => r.deviceId === device.id);
    expect(mine?.poolRead).toMatchObject({ verdict: 'blind', lastFailure: { status: 525 } });

    const tool = forgeRunnersTool({ principal: { kind: 'user', userId: user.id } } as never);
    const listed = (await tool.handler({ action: 'list', projectId: first.id } as never)) as {
      runners: Array<{ deviceId: string; poolRead: unknown }>;
    };
    const row = listed.runners.find((r) => r.deviceId === device.id);
    expect(row?.poolRead).toMatchObject({ verdict: 'blind', unreadSince: BLIND.unreadSince });
  });

  it('reads null on both surfaces for a runner whose box reported no failed read', async () => {
    const { user, jwt, first } = await twoProjectBox();
    const res = await fetch(`${server.baseUrl}/api/projects/${first.id}/runners`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const rows = (await res.json()) as Array<{ poolRead: unknown }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.poolRead).toBeNull();
    const tool = forgeRunnersTool({ principal: { kind: 'user', userId: user.id } } as never);
    const listed = (await tool.handler({ action: 'list', projectId: first.id } as never)) as {
      runners: Array<{ poolRead: unknown }>;
    };
    for (const r of listed.runners) expect(r.poolRead).toBeNull();
  });
});
