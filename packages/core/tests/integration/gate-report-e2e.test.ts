/**
 * ISS-1192 — a gate that stopped deciding, carried off the box it happened on,
 * against real Postgres.
 *
 * The point of this file is the crossing. Unit tests on either side prove that
 * the box derives a condition and that core can read one; what nothing else
 * proves is that the column, the two device surfaces and the run's own record
 * all still carry it once the report has been through a heartbeat. That is
 * where a shape change goes unnoticed, and the counter this issue is about
 * spent 3.7 days unnoticed already.
 *
 * The condition planted here is the fixture both languages read,
 * `src/devices/gate-report.fixture.json`, so this suite and
 * `transport/heartbeat.rs` are asserting the same 24 marks.
 */

import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
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
  readFileSync(new URL('../../src/devices/gate-report.fixture.json', import.meta.url), 'utf8'),
) as { wire: { maxReasons: number; units: number }; degraded: Record<string, unknown> };

/** The gate body itself: the fixture carries the wire bounds beside it. */
const onTheWire = { degraded: fixture.degraded };

describe('a box reports its declaration gate and core keeps it', () => {
  let harness: TestDatabase;
  let heartbeatPatch: typeof import('../../src/devices/heartbeat-patch.js').heartbeatPatch;
  let readHeartbeatGate: typeof import('../../src/devices/gate-report.js').readHeartbeatGate;
  let readDeviceLoad: typeof import('../../src/devices/load.js').readDeviceLoad;
  let readFleetLoad: typeof import('../../src/devices/load.js').readFleetLoad;
  let openRunSession: typeof import('../../src/devices/run-session.js').openRunSession;
  let RUN_GATE_METADATA_KEY: string;
  let server!: TestServer;
  let signUserToken!: typeof import('../../src/auth/jwt.js').signUserToken;

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

    ({ heartbeatPatch } = await import('../../src/devices/heartbeat-patch.js'));
    ({ readHeartbeatGate } = await import('../../src/devices/gate-report.js'));
    ({ readDeviceLoad, readFleetLoad } = await import('../../src/devices/load.js'));
    ({ openRunSession, RUN_GATE_METADATA_KEY } = await import('../../src/devices/run-session.js'));
    ({ signUserToken } = await import('../../src/auth/jwt.js'));
    server = await startTestServer();
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  /**
   * `reported: false` is a box that never sent one. It is a flag rather than an
   * absent argument because a default parameter cannot tell `undefined` passed
   * on purpose from one not passed at all, and this suite's whole subject is
   * the difference between no report and a report of nothing.
   */
  async function boxThatReported({ reported = true }: { reported?: boolean } = {}) {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const device = await createTestDevice(harness.db, user.id);
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at)
      VALUES (gen_random_uuid(), ${project.id}, 'claude-code', ${device.id},
              'gate-runner', 'online', now())
    `);
    if (reported) {
      const read = readHeartbeatGate(onTheWire);
      expect(read.refused).toBeUndefined();
      const patch = heartbeatPatch({ gate: read.report }, new Date());
      await harness.db.execute(sql`
        UPDATE devices SET gate_report = ${JSON.stringify(patch.gateReport)}::jsonb,
                           last_seen_at = now(), status = 'online'
        WHERE id = ${device.id}
      `);
    }
    return { user, project, device };
  }

  it('keeps the report on the device with the time it was heard', async () => {
    const { device } = await boxThatReported();
    const rows = (await harness.db.execute(sql`
      SELECT gate_report FROM devices WHERE id = ${device.id}
    `)) as unknown as Array<{ gate_report: Record<string, unknown> }>;
    const stored = rows[0]?.gate_report as {
      degraded: { count: number; verdict: string };
      receivedAt: string;
    };
    expect(stored.degraded.count).toBe(24);
    expect(stored.degraded.verdict).toBe('failing_open');
    expect(Date.parse(stored.receivedAt)).not.toBeNaN();
  });

  it('answers the dispatching master with it at /me/load', async () => {
    const { device } = await boxThatReported();
    const load = await readDeviceLoad(device.id);
    expect(load?.gate).toMatchObject({ verdict: 'failing_open', count: 24, perDay: 144 });
  });

  it('answers with it for every box in the project fleet', async () => {
    const { project } = await boxThatReported();
    const fleet = await readFleetLoad(project.id, 300);
    expect(fleet[0]?.gate).toMatchObject({ verdict: 'failing_open', count: 24 });
  });

  it('answers null for a box that has never reported a gate', async () => {
    const { device, project } = await boxThatReported({ reported: false });
    expect((await readDeviceLoad(device.id))?.gate).toBeNull();
    expect((await readFleetLoad(project.id, 300))[0]?.gate).toBeNull();
  });

  // The device's report says what is true now. A run has to carry what was true
  // then, or "was the gate deciding while this ran" is unanswerable the moment
  // the box's window rolls over.
  it('stamps a run session with the condition the box opened it under', async () => {
    const { device, project } = await boxThatReported();
    const opened = await openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-1'],
      name: 'ISS-1',
      gate: fixture.degraded as never,
    });
    const rows = (await harness.db.execute(sql`
      SELECT metadata FROM pipeline_runs WHERE id = ${opened.runId}
    `)) as unknown as Array<{ metadata: Record<string, unknown> }>;
    const stamped = rows[0]?.metadata?.[RUN_GATE_METADATA_KEY] as { verdict: string };
    expect(stamped.verdict).toBe('failing_open');
  });

  it('stamps none where the box sent none, rather than a gate that was clear', async () => {
    const { device, project } = await boxThatReported({ reported: false });
    const opened = await openRunSession({
      deviceId: device.id,
      projectId: project.id,
      issueKeys: ['ISS-1'],
      name: 'ISS-1',
    });
    const rows = (await harness.db.execute(sql`
      SELECT metadata FROM pipeline_runs WHERE id = ${opened.runId}
    `)) as unknown as Array<{ metadata: Record<string, unknown> }>;
    expect(rows[0]?.metadata).not.toHaveProperty(RUN_GATE_METADATA_KEY);
  });

  /**
   * The heartbeat over HTTP, against the real route and a real device token.
   * The route's own job is liveness; the gate rides along, and what has to hold
   * is that a field core cannot read never costs a box that.
   */
  describe('the heartbeat route', () => {
    async function pairedBox() {
      const user = await createTestUser(harness.db, { emailVerifiedAt: new Date() });
      const project = await createTestProject(harness.db, user.id);
      const jwt = await signUserToken(user.id);
      const device = await pairMockDevice({ server, projectId: project.id, userJwt: jwt });
      return { device, jwt };
    }

    const beat = (token: string, body: unknown) =>
      fetch(`${server.baseUrl}/api/devices/heartbeat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const storedFor = async (deviceId: string) => {
      const rows = (await harness.db.execute(sql`
        SELECT gate_report, status FROM devices WHERE id = ${deviceId}
      `)) as unknown as Array<{ gate_report: unknown; status: string }>;
      return rows[0];
    };

    it('takes the condition and answers that it did', async () => {
      const { device } = await pairedBox();
      const res = await beat(device.token, { agentVersion: '0.17.17', gate: onTheWire });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, gate: { accepted: true } });
      const row = await storedFor(device.id);
      expect(row?.gate_report).toMatchObject({ degraded: { count: 24, verdict: 'failing_open' } });
    });

    it('leaves the stored condition standing when the next heartbeat carries none', async () => {
      const { device } = await pairedBox();
      await beat(device.token, { gate: onTheWire });
      const res = await beat(device.token, { agentVersion: '0.17.17' });
      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('gate');
      expect((await storedFor(device.id))?.gate_report).toMatchObject({
        degraded: { count: 24 },
      });
    });

    it('refuses a condition it cannot read by name, and keeps the box online', async () => {
      const { device } = await pairedBox();
      const res = await beat(device.token, {
        agentVersion: '0.17.17',
        gate: { degraded: { ...fixture.degraded, verdict: 'catastrophe' } },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        gate?: { accepted: boolean; reason?: string };
      };
      expect(body.ok).toBe(true);
      expect(body.gate?.accepted).toBe(false);
      expect(body.gate?.reason).toContain('degraded.verdict');
      const row = await storedFor(device.id);
      expect(row?.gate_report).toBeNull();
      expect(row?.status).toBe('online');
    });

    it('lists the condition on the owner\u2019s devices, and null where none was sent', async () => {
      const { device, jwt } = await pairedBox();
      const listed = async () => {
        const res = await fetch(`${server.baseUrl}/api/me/devices`, {
          headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.status).toBe(200);
        const rows = (await res.json()) as Array<Record<string, unknown>>;
        return rows.find((r) => r.id === device.id);
      };
      expect((await listed())?.gate).toBeNull();
      await beat(device.token, { gate: onTheWire });
      const row = await listed();
      expect(row?.gate).toMatchObject({ verdict: 'failing_open', count: 24 });
      expect(row).not.toHaveProperty('gateReport');
    });
  });
});
