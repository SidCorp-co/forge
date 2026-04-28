import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type MockDevice,
  type TestDatabase,
  type TestServer,
  type WebObserver,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  pairMockDevice,
  setProjectActiveDevice,
  setupTestDatabase,
  startTestServer,
  startWebObserver,
  truncateAll,
} from '../helpers/index.js';

// Phase 2.7-F2 (ISS-218) — full device-runner happy path E2E.
//
// Exercises: pair → ws connect → project binding → enqueue → dispatcher →
// job.assigned broadcast → batched JobEvent POSTs → post-commit project
// broadcast → /complete → job.completed broadcast → dangling-resource check.
//
// Gated behind `FORGE_E2E_REAL_PAIR=1` while ISS-214's server endpoints
// (`POST /api/devices/pairing-codes`, `POST /api/devices/pair`,
// `POST /api/devices/heartbeat`, WS handshake auth, `PUT /api/projects/:id/runtime/active-device`)
// are not yet in the tree. The helper falls back to `issueDeviceToken` so the
// test compiles and is ready to flip once those endpoints land.
const runE2E = process.env.FORGE_E2E_REAL_PAIR === '1';

describe.skipIf(!runE2E)('F2 device-runner E2E', () => {
  let harness: TestDatabase;
  let server: TestServer;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    // MUST set DATABASE_URL BEFORE any src import loads env.ts — mirror
    // pipeline-e2e.test.ts:40-56 exactly.
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

    server = await startTestServer();
  }, 90_000);

  afterAll(async () => {
    await server?.close();
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seed() {
    const user = await createTestUser(harness.db);
    await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
    const project = await createTestProject(harness.db, user.id);
    await createTestProjectMember(harness.db, {
      userId: user.id,
      projectId: project.id,
      role: 'owner',
    });
    return { user, project };
  }

  it('pair → dispatch → stream → complete', async () => {
    const { signUserToken } = await import('../../src/auth/jwt.js');

    const { user, project } = await seed();
    const userJwt = await signUserToken(user.id);

    // 1. Pair device (AC: pair <2s)
    const t0 = performance.now();
    const device: MockDevice = await pairMockDevice({
      server,
      db: harness.db,
      ownerId: user.id,
    });
    expect(performance.now() - t0).toBeLessThan(2_000);

    // 2. Device connects WS
    await device.connectWs();

    // 3. Bind project → device. Real flow uses `PUT /api/projects/:id/runtime/active-device`
    //    (blocked on ISS-214); today we set it directly so the dispatcher can route.
    await setProjectActiveDevice(harness.db, project.id, device.id);
    // Device must also be online for the dispatcher to pick it.
    await harness.db.execute(sql`UPDATE devices SET status = 'online' WHERE id = ${device.id}`);

    // 4. Open a web observer on the project room
    const observer: WebObserver = await startWebObserver({
      server,
      userJwt,
      projectId: project.id,
    });

    // 5. Enqueue a job (AC: dispatch <500ms end-to-end to device.job.assigned)
    const t1 = performance.now();
    const jobRes = await fetch(`${server.baseUrl}/api/projects/${project.id}/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${userJwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'plan', payload: { skillName: 'forge-plan', args: {} } }),
    });
    expect(jobRes.status).toBe(201);
    const { id: jobId } = (await jobRes.json()) as { id: string };

    const assign = await device.waitForAssign(3_000);
    expect(assign.jobId).toBe(jobId);
    expect(assign.at - t1).toBeLessThan(500);

    // 6. Mock claude-cli streams JobEvents (AC: first event <5s observer-visible)
    const t2 = performance.now();
    const firstRes = await device.postEvents(jobId, [
      { kind: 'stdout', data: { line: 'booting' } },
    ]);
    expect(firstRes.status).toBe(200);

    const firstEvent = await observer.waitFor(
      (ev) =>
        ev.event === 'job.event' && !!ev.data && (ev.data as { jobId?: string }).jobId === jobId,
      5_000,
    );
    expect(firstEvent.at - t2).toBeLessThan(5_000);

    // Bulk batch + terminal-ish result marker.
    const bulk = Array.from({ length: 32 }, (_, i) => ({
      kind: 'stdout',
      data: { line: `chunk-${i}` },
    }));
    const bulkRes = await device.postEvents(jobId, bulk);
    expect(bulkRes.status).toBe(200);
    const resultRes = await device.postEvents(jobId, [{ kind: 'result', data: { summary: 'ok' } }]);
    expect(resultRes.status).toBe(200);

    // 7. Device completes the job
    const completeRes = await device.complete(jobId, { exitCode: 0 });
    expect(completeRes.status).toBe(200);

    // 8. Web observer sees job.completed
    await observer.waitFor(
      (ev) =>
        ev.event === 'job.completed' &&
        !!ev.data &&
        (ev.data as { jobId?: string }).jobId === jobId,
      2_000,
    );

    // 9. DB assertions — monotonic server-assigned seq, correct terminal row
    const eventRows = await harness.db.execute<{ seq: number; kind: string }>(sql`
      SELECT seq, kind FROM job_events WHERE job_id = ${jobId} ORDER BY seq ASC
    `);
    expect(eventRows.length).toBe(1 + 32 + 1);
    expect(eventRows.map((r) => Number(r.seq))).toEqual(
      Array.from({ length: 34 }, (_, i) => i + 1),
    );

    const jobRows = await harness.db.execute<{ status: string; exit_code: number | null }>(sql`
      SELECT status, exit_code FROM jobs WHERE id = ${jobId}
    `);
    const finalJob = jobRows[0] as { status: string; exit_code: number | null };
    expect(finalJob.status).toBe('done');
    expect(finalJob.exit_code).toBe(0);

    // 10. Cleanup — close clients, verify no dangling sockets / queued jobs
    await device.close();
    await observer.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.openSocketCount()).toBe(0);

    const queuedRows = await harness.db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM jobs
      WHERE status IN ('queued', 'dispatched', 'running')
    `);
    expect(Number((queuedRows[0] as { n: number }).n)).toBe(0);
  }, 30_000);
});
